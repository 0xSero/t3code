import type { LocalStudioGatewayClient } from "@local-studio/t3-providers";
import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { LocalStudioGateway } from "../../localStudio/LocalStudioGateway.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }),
    }),
  ),
});
const decodeCompletion = Schema.decodeUnknownEffect(ChatCompletion);
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeLocalStudioTextGeneration = Effect.fn("makeLocalStudioTextGeneration")(
  function* (input: {
    readonly gateway: LocalStudioGateway["Service"];
    readonly client: LocalStudioGatewayClient;
    readonly defaultModel: string | undefined;
  }) {
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;

    const complete = <S extends Schema.Top>(
      operation: Operation,
      prompt: string,
      outputSchema: S,
      modelSelection: ModelSelection,
    ): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const baseUrl = yield* input.gateway.gatewayUrl;
        const { keyFile } = yield* input.gateway.ensureHarnessKey(input.client);
        const key = (yield* fileSystem.readFileString(keyFile)).trim();
        const model = modelSelection.model || input.defaultModel;
        if (!model) {
          return yield* new TextGenerationError({
            operation,
            detail: "No local models running — open Local AI.",
          });
        }
        const response = yield* httpClient.execute(
          HttpClientRequest.post(`${baseUrl}/v1/chat/completions`).pipe(
            HttpClientRequest.bearerToken(key),
            HttpClientRequest.setHeader("x-local-studio-client", input.client),
            HttpClientRequest.bodyJsonUnsafe({
              model,
              stream: false,
              messages: [
                {
                  role: "system",
                  content: "Reply with a single JSON object that matches the requested shape.",
                },
                { role: "user", content: prompt },
              ],
            }),
          ),
        );
        if (response.status !== 200) {
          return yield* new TextGenerationError({
            operation,
            detail: `Local Studio gateway returned ${response.status}.`,
          });
        }
        const body = yield* decodeCompletion(yield* response.json);
        const text = body.choices[0]?.message.content?.trim() ?? "";
        if (!text) {
          return yield* new TextGenerationError({
            operation,
            detail: "The local model returned empty output.",
          });
        }
        return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
          extractJsonObject(text),
        );
      }).pipe(
        Effect.timeout("5 minutes"),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Local Studio text generation failed.",
                cause,
              }),
        ),
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("LocalStudioTextGeneration.generateCommitMessage")(function* (request) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: request.branch,
          stagedSummary: request.stagedSummary,
          stagedPatch: request.stagedPatch,
          includeBranch: request.includeBranch === true,
          policy: request.policy,
        });
        const generated = yield* complete(
          "generateCommitMessage",
          prompt,
          outputSchema,
          request.modelSelection,
        );
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      });

    const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
      Effect.fn("LocalStudioTextGeneration.generatePrContent")(function* (request) {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: request.baseBranch,
          headBranch: request.headBranch,
          commitSummary: request.commitSummary,
          diffSummary: request.diffSummary,
          diffPatch: request.diffPatch,
          policy: request.policy,
          changeRequestTemplate: request.changeRequestTemplate,
        });
        const generated = yield* complete(
          "generatePrContent",
          prompt,
          outputSchema,
          request.modelSelection,
        );
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
      Effect.fn("LocalStudioTextGeneration.generateBranchName")(function* (request) {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: request.message,
          attachments: request.attachments,
        });
        const generated = yield* complete(
          "generateBranchName",
          prompt,
          outputSchema,
          request.modelSelection,
        );
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("LocalStudioTextGeneration.generateThreadTitle")(function* (request) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: request.message,
          previousTitle: request.previousTitle,
          linkedContext: request.linkedContext,
          attachments: request.attachments,
        });
        const generated = yield* complete(
          "generateThreadTitle",
          prompt,
          outputSchema,
          request.modelSelection,
        );
        return {
          title: sanitizeThreadTitle(generated.title),
          ...(generated.needsRefinement ? { needsRefinement: true } : {}),
        } satisfies TextGeneration.ThreadTitleGenerationResult;
      });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"];
  },
);
