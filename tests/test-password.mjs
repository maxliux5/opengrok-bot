export const testPassword = process.env.OPENGROK_TEST_PASSWORD;

if (!testPassword) {
  throw new Error("Set OPENGROK_TEST_PASSWORD for the isolated smoke account");
}
