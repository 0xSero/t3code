export const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
const CLI_RELEASE_TAG_PREFIX = "v";
export const CLI_RELEASE_TAG = {
  prefix: CLI_RELEASE_TAG_PREFIX,
  pattern: new RegExp(`^${CLI_RELEASE_TAG_PREFIX}(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`),
} as const;
