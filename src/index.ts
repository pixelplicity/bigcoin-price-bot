import {
  Client,
  GatewayIntentBits,
  ChannelType,
  VoiceChannel,
  CategoryChannel
} from 'discord.js';
import { CronJob } from 'cron';
import axios from 'axios';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

interface StatsResponse {
  blocksUntilHalving: number;
  currentEmissions: number;
  globalHashRate: number;
  bigPrice: number;
}

const TOKEN = process.env.DISCORD_TOKEN!;
const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error('REDIS_URL environment variable is required');
}

const GUILD_KEY = `guilds`;

const redis = new Redis(REDIS_URL);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

function formatNumber(number: number) {
  return number.toLocaleString('en-US', {
    maximumFractionDigits: 2,
    notation: 'compact',
    compactDisplay: 'short'
  });
}

async function getStats(): Promise<{
  price: number;
  blocksUntilHalving: number;
}> {
  const response = await axios.get<StatsResponse>(
    'https://bigpool.tech/api/stats/global'
  );
  return {
    price: response.data.bigPrice,
    blocksUntilHalving: response.data.blocksUntilHalving
  };
}

async function getGuilds(): Promise<string[]> {
  const guilds = await redis.get(GUILD_KEY);
  if (!guilds) {
    return [];
  }
  return JSON.parse(guilds);
}

async function addGuild(guildId: string) {
  console.log(`addGuild: ${guildId}`);
  const guilds = await getGuilds();
  if (!guilds) {
    await redis.set(GUILD_KEY, JSON.stringify([guildId]));
  } else {
    guilds.push(guildId);
    await redis.set(GUILD_KEY, JSON.stringify(Array.from(new Set(guilds))));
  }
  return guilds;
}

async function removeGuild(guildId: string) {
  console.log(`removeGuild: ${guildId}`);
  const guilds = await getGuilds();
  if (guilds.length === 0) {
    return;
  } else {
    const newGuilds = guilds.filter((id: string) => id !== guildId);
    await redis.set(GUILD_KEY, JSON.stringify(Array.from(new Set(newGuilds))));
  }
  return guilds;
}

async function getChannelGroupId(guildId: string): Promise<string | undefined> {
  const id = await redis.get(`${guildId}:channelGroup`);
  if (!id) {
    return undefined;
  }
  return id;
}

async function setChannelGroupId(guildId: string, id: string) {
  await redis.set(`${guildId}:channelGroup`, id);
}

async function removeChannelGroupId(guildId: string) {
  await redis.del(`${guildId}:channelGroup`);
}

async function getPriceChannelId(guildId: string): Promise<string | undefined> {
  const id = await redis.get(`${guildId}:priceChannel`);
  if (!id) {
    return undefined;
  }
  return id;
}

async function setPriceChannelId(guildId: string, id: string) {
  await redis.set(`${guildId}:priceChannel`, id);
}

async function removePriceChannelId(guildId: string) {
  await redis.del(`${guildId}:priceChannel`);
}

async function getHalveningChannelId(
  guildId: string
): Promise<string | undefined> {
  const id = await redis.get(`${guildId}:halveningChannel`);
  if (!id) {
    return undefined;
  }
  return id;
}

async function setHalveningChannelId(guildId: string, id: string) {
  await redis.set(`${guildId}:halveningChannel`, id);
}

async function removeHalveningChannelId(guildId: string) {
  await redis.del(`${guildId}:halveningChannel`);
}

async function updatePrice() {
  const { price, blocksUntilHalving } = await getStats();
  const guilds = await getGuilds();
  console.log(
    `Updating price to $${price} and halvening to ${formatNumber(
      blocksUntilHalving
    )} blocks for ${guilds.length} guilds`
  );
  if (guilds.length === 0) {
    return;
  }
  for (const guildId of guilds) {
    await updatePriceChannel(guildId, price);
    await updateHalveningChannel(guildId, blocksUntilHalving);
  }
}

async function createChannelGroup(guildId: string): Promise<string> {
  const guild = await client.guilds.fetch(guildId);
  const channelGroup = await guild.channels.create({
    name: '🌕 BIGCOIN',
    type: ChannelType.GuildCategory,
    position: 0
  });
  await setChannelGroupId(guildId, channelGroup.id);
  console.log(`Created channel group in ${guild.name}`);
  return channelGroup.id;
}

async function ensureChannelGroupExists(guildId: string): Promise<string> {
  const guild = await client.guilds.fetch(guildId);
  const channelGroupId = await getChannelGroupId(guildId);

  if (!channelGroupId) {
    return await createChannelGroup(guildId);
  }

  // Verify the channel group still exists
  try {
    const existingChannelGroup = (await guild.channels.fetch(
      channelGroupId
    )) as CategoryChannel;
    if (existingChannelGroup) {
      return channelGroupId;
    }
  } catch (error) {
    console.log(`Channel group not found in ${guild.name}, creating new one`);
  }

  // Channel group doesn't exist, create a new one
  await removeChannelGroupId(guildId);
  return await createChannelGroup(guildId);
}

async function removeChannelGroup(guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  const id = await getChannelGroupId(guildId);
  if (id) {
    try {
      const channelGroup = await guild.channels.fetch(id);
      if (channelGroup) {
        await channelGroup.delete();
      }
    } catch (error) {
      console.log(
        `Channel group already deleted or not found in ${guild.name}`
      );
    }
    await removeChannelGroupId(guildId);
  }
  console.log(`Removed channel group in ${guild.name}`);
}

async function removePriceChannel(guildId: string) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const priceChannelId = await getPriceChannelId(guildId);

    if (priceChannelId) {
      try {
        const priceChannel = await guild.channels.fetch(priceChannelId);
        if (priceChannel) {
          await priceChannel.delete();
          console.log(`Deleted price channel in ${guild.name}`);
        }
      } catch (error) {
        console.log(
          `Price channel already deleted or not found in ${guild.name}`
        );
      }
      await removePriceChannelId(guildId);
    }
  } catch (error) {
    console.error(`Error removing price channel in ${guildId}: ${error}`);
  }
}

async function removeHalveningChannel(guildId: string) {
  try {
    const guild = await client.guilds.fetch(guildId);
    const halveningChannelId = await getHalveningChannelId(guildId);

    if (halveningChannelId) {
      try {
        const halveningChannel = await guild.channels.fetch(halveningChannelId);
        if (halveningChannel) {
          await halveningChannel.delete();
          console.log(`Deleted halvening channel in ${guild.name}`);
        }
      } catch (error) {
        console.log(
          `Halvening channel already deleted or not found in ${guild.name}`
        );
      }
      await removeHalveningChannelId(guildId);
    }
  } catch (error) {
    console.error(`Error removing halvening channel in ${guildId}: ${error}`);
  }
}

async function updateChannel(
  guildId: string,
  channelType: 'price' | 'halvening',
  value: string,
  position: number
) {
  try {
    const guild = await client.guilds.fetch(guildId);

    // Comprehensive bot permissions check
    const botMember = await guild.members.fetch(client.user!.id);
    const permissions = botMember.permissions;

    console.log(`Checking permissions for bot in ${guild.name}:`);
    console.log(`- ManageChannels: ${permissions.has('ManageChannels')}`);
    console.log(`- ViewChannel: ${permissions.has('ViewChannel')}`);
    console.log(`- ManageRoles: ${permissions.has('ManageRoles')}`);
    console.log(`- Bot role position: ${botMember.roles.highest.position}`);

    if (!permissions.has('ManageChannels')) {
      console.error(
        `Bot missing ManageChannels permission in ${guild.name}. Cannot update channels.`
      );
      return;
    }

    // Check if bot has permission to manage the specific channel type
    if (!permissions.has('ViewChannel')) {
      console.error(
        `Bot missing ViewChannel permission in ${guild.name}. Cannot view channels.`
      );
      return;
    }

    // Check bot's role hierarchy position
    const botRolePosition = botMember.roles.highest.position;
    console.log(`Bot's highest role position: ${botRolePosition}`);

    if (botRolePosition === 0) {
      console.error(
        `Bot has no roles in ${guild.name}. Cannot manage channels.`
      );
      return;
    }

    // Ensure channel group exists
    const channelGroupId = await ensureChannelGroupExists(guildId);
    let channelGroup: CategoryChannel;

    try {
      channelGroup = (await guild.channels.fetch(
        channelGroupId
      )) as CategoryChannel;
      console.log(
        `Successfully fetched channel group ${channelGroup.name} (${channelGroup.id}) in ${guild.name}`
      );

      // Verify the channel group is actually a category
      if (channelGroup.type !== ChannelType.GuildCategory) {
        throw new Error(
          `Channel group is not a category: ${channelGroup.type}`
        );
      }
    } catch (error) {
      console.error(
        `Failed to fetch channel group ${channelGroupId} in ${guild.name}, recreating... Error: ${error}`
      );
      await removeChannelGroupId(guildId);
      const newChannelGroupId = await createChannelGroup(guildId);
      channelGroup = (await guild.channels.fetch(
        newChannelGroupId
      )) as CategoryChannel;
      console.log(
        `Recreated channel group ${channelGroup.name} (${channelGroup.id}) in ${guild.name}`
      );
    }

    // Get existing channel ID from Redis
    const getChannelId =
      channelType === 'price' ? getPriceChannelId : getHalveningChannelId;
    const setChannelId =
      channelType === 'price' ? setPriceChannelId : setHalveningChannelId;
    const removeChannelId =
      channelType === 'price' ? removePriceChannelId : removeHalveningChannelId;

    let channelId = await getChannelId(guildId);
    let channel: VoiceChannel | null = null;

    // If we have a stored channel ID, try to fetch it
    if (channelId) {
      try {
        const fetchedChannel = await guild.channels.fetch(channelId);
        if (!fetchedChannel) {
          console.log(
            `Stored ${channelType} channel not found in ${guild.name}, will create new one`
          );
          channelId = undefined;
          await removeChannelId(guildId);
        } else {
          console.log(
            `Successfully fetched ${channelType} channel: ${fetchedChannel.name} (${fetchedChannel.id}) in ${guild.name}`
          );
          console.log(`- Channel type: ${fetchedChannel.type}`);
          console.log(`- Current parent: ${fetchedChannel.parentId}`);
          console.log(`- Target parent: ${channelGroup.id}`);

          if ('position' in fetchedChannel) {
            console.log(`- Current position: ${fetchedChannel.position}`);
          }
          console.log(`- Target position: ${position}`);

          if (fetchedChannel.type !== ChannelType.GuildVoice) {
            console.error(
              `Stored ${channelType} channel is not a voice channel: ${fetchedChannel.type}`
            );
            await removeChannelId(guildId);
            channelId = undefined;
          } else {
            channel = fetchedChannel as VoiceChannel;
          }
        }
      } catch (error) {
        console.log(
          `Stored ${channelType} channel not found in ${guild.name}, will create new one`
        );
        channelId = undefined;
        await removeChannelId(guildId);
      }
    }

    // If no channel exists, create one
    if (!channel) {
      try {
        const newChannel = await guild.channels.create({
          name: value,
          type: ChannelType.GuildVoice,
          parent: channelGroup.id,
          position: position,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              deny: ['Connect', 'ViewChannel', 'Speak', 'Stream']
            },
            {
              id: client.user!.id,
              allow: ['ManageChannels', 'ViewChannel']
            }
          ]
        });

        await setChannelId(guildId, newChannel.id);
        console.log(`Created ${channelType} channel in ${guild.name}`);
      } catch (createError) {
        console.error(
          `Failed to create ${channelType} channel in ${guild.name}:`,
          createError
        );
        throw createError;
      }
    } else {
      // Update existing channel
      try {
        // Check if channel is manageable
        if (!channel.manageable) {
          console.log(
            `Channel not manageable in ${guild.name}, attempting to fix permissions...`
          );
          try {
            await channel.permissionOverwrites.create(client.user!.id, {
              ManageChannels: true,
              ViewChannel: true
            });
            console.log(
              `Successfully updated permissions for ${channelType} channel in ${guild.name}`
            );
          } catch (permError) {
            console.error(
              `Failed to update permissions for ${channelType} channel in ${guild.name}:`,
              permError
            );
            return;
          }
        }

        // Only update name if it's different
        if (channel.name !== value) {
          console.log(
            `Updating ${channelType} channel name from "${channel.name}" to "${value}" in ${guild.name}`
          );
          try {
            await channel.setName(value);
            console.log(
              `Successfully updated ${channelType} channel name in ${guild.name}`
            );
          } catch (nameError) {
            console.error(
              `Failed to update ${channelType} channel name in ${guild.name}:`,
              nameError
            );
            return; // Don't continue with other operations if name update fails
          }
        } else {
          console.log(
            `${channelType} channel name already correct in ${guild.name}`
          );
        }

        // Only move to category if it's different and category exists
        if (channel.parentId !== channelGroup.id) {
          console.log(
            `Moving ${channelType} channel from parent ${channel.parentId} to ${channelGroup.id} in ${guild.name}`
          );
          try {
            await channel.edit({
              parent: channelGroup.id
            });
            console.log(
              `Successfully moved ${channelType} channel to category in ${guild.name}`
            );
          } catch (moveError) {
            console.error(
              `Failed to move ${channelType} channel to category in ${guild.name}:`,
              moveError
            );
            // Continue without moving the channel
          }
        } else {
          console.log(
            `${channelType} channel already in correct category in ${guild.name}`
          );
        }

        // Only update position if it's different
        if (channel.position !== position) {
          console.log(
            `Updating ${channelType} channel position from ${channel.position} to ${position} in ${guild.name}`
          );
          try {
            await channel.edit({
              position: position
            });
            console.log(
              `Successfully updated ${channelType} channel position in ${guild.name}`
            );
          } catch (positionError) {
            console.error(
              `Failed to update ${channelType} channel position in ${guild.name}:`,
              positionError
            );
            // Continue without updating position
          }
        } else {
          console.log(
            `${channelType} channel already in correct position in ${guild.name}`
          );
        }
      } catch (editError) {
        console.error(
          `Failed to edit ${channelType} channel in ${guild.name}:`,
          editError
        );
        throw editError;
      }
    }
  } catch (error) {
    console.error(
      `Error updating ${channelType} channel in ${guildId}: ${error}`
    );
  }
}

async function updatePriceChannel(guildId: string, price: number) {
  const newName = `$BIG: ${formatter.format(price)}`;
  await updateChannel(guildId, 'price', newName, 0);
}

async function updateHalveningChannel(
  guildId: string,
  blocksUntilHalving: number
) {
  const newName = `HALVENING: ${formatNumber(blocksUntilHalving)}`;
  await updateChannel(guildId, 'halvening', newName, 1);
}

client.once('ready', async () => {
  console.log(`Bigcoin Price Bot Ready!`);

  new CronJob('*/60 * * * * *', updatePrice, null, true, 'America/New_York');

  updatePrice();
});

client.on('guildCreate', async guild => {
  const { price, blocksUntilHalving } = await getStats();
  await updatePriceChannel(guild.id, price);
  await updateHalveningChannel(guild.id, blocksUntilHalving);
  await addGuild(guild.id);
});

client.on('guildDelete', async guild => {
  await removeGuild(guild.id);
  await removePriceChannel(guild.id);
  await removeHalveningChannel(guild.id);
  await removeChannelGroup(guild.id);
});

client.login(TOKEN);
