import type {} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LOCAL_STUDIO_THINKING_LEVELS = [
  { value: "default", label: "Harness default" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export const LOCAL_AI_HARNESS_CHOICES = [
  { value: "auto", label: "Automatic (omp, then pi)" },
  { value: "omp", label: "omp" },
  { value: "pi", label: "pi" },
] as const;

const hiddenEnabled = (defaultValue: boolean) =>
  Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(defaultValue)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  );

const textSetting = (input: {
  readonly title: string;
  readonly description: string;
  readonly placeholder: string;
}) =>
  Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: input.title,
      description: input.description,
      providerSettingsForm: { placeholder: input.placeholder, clearWhenEmpty: "omit" },
    }),
  );

const thinkingLevelSetting = Schema.Literals(
  LOCAL_STUDIO_THINKING_LEVELS.map((level) => level.value),
).pipe(
  Schema.withDecodingDefault(Effect.succeed("default" as const)),
  Schema.annotateKey({
    title: "Thinking level",
    description: "Reasoning effort requested from the harness for each turn.",
    providerSettingsForm: { control: "select", options: LOCAL_STUDIO_THINKING_LEVELS },
  }),
);

const harnessSettingsFields = (binary: "omp" | "pi") => ({
  enabled: hiddenEnabled(true),
  binaryPath: textSetting({
    title: "Binary path",
    description: `Path to the ${binary} binary. Leave empty to use ${binary} from PATH.`,
    placeholder: binary,
  }),
  defaultModel: textSetting({
    title: "Default model",
    description: "Local Studio model id used when a thread does not pick one.",
    placeholder: "glm-5.3-flash",
  }),
  thinkingLevel: thinkingLevelSetting,
  extraArgs: textSetting({
    title: "Extra arguments",
    description: `Additional CLI arguments passed to ${binary}.`,
    placeholder: "--flag value",
  }),
});

const withOrder = <S extends Schema.Top>(schema: S, order: ReadonlyArray<string>) =>
  schema.pipe(Schema.annotate({ providerSettingsFormSchema: { order: [...order] } }));

export const OmpSettings = withOrder(Schema.Struct(harnessSettingsFields("omp")), [
  "binaryPath",
  "defaultModel",
  "thinkingLevel",
  "extraArgs",
]);
export type OmpSettings = typeof OmpSettings.Type;

export const PiSettings = withOrder(Schema.Struct(harnessSettingsFields("pi")), [
  "binaryPath",
  "defaultModel",
  "thinkingLevel",
  "extraArgs",
]);
export type PiSettings = typeof PiSettings.Type;

export const LocalAiSettings = withOrder(
  Schema.Struct({
    enabled: hiddenEnabled(true),
    harness: Schema.Literals(LOCAL_AI_HARNESS_CHOICES.map((choice) => choice.value)).pipe(
      Schema.withDecodingDefault(Effect.succeed("auto" as const)),
      Schema.annotateKey({
        title: "Agent harness",
        description: "Agent that runs Local AI threads against the Local Studio gateway.",
        providerSettingsForm: { control: "select", options: LOCAL_AI_HARNESS_CHOICES },
      }),
    ),
    ompBinaryPath: textSetting({
      title: "omp binary path",
      description: "Path to the omp binary. Leave empty to use omp from PATH.",
      placeholder: "omp",
    }),
    piBinaryPath: textSetting({
      title: "pi binary path",
      description: "Path to the pi binary. Leave empty to use pi from PATH.",
      placeholder: "pi",
    }),
    thinkingLevel: thinkingLevelSetting,
  }),
  ["harness", "thinkingLevel", "ompBinaryPath", "piBinaryPath"],
);
export type LocalAiSettings = typeof LocalAiSettings.Type;
