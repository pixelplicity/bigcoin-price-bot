declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: 'development' | 'production' | 'test';
    DISCORD_TOKEN: string;
    REDIS_URL: string;
  }
}
