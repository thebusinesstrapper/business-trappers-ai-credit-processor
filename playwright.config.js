export default {
  use: {
    headless: true,
    viewport: {
      width: 1440,
      height: 900
    },
    ignoreHTTPSErrors: true,
    actionTimeout: 30000,
    navigationTimeout: 60000
  },

  timeout: 120000,

  retries: 1
};
