/**
 * Reload Runtime Extension
 *
 * Adds `/reload-runtime` plus an LLM-callable `reload_runtime` tool so the agent
 * can trigger a reload of extensions, skills, prompts, themes, and context files.
 * Copied from pi's examples/extensions/reload-runtime.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	// Command entrypoint for reload. Reload is terminal for this handler.
	pi.registerCommand("reload-runtime", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	// Tools get ExtensionContext, so they cannot call ctx.reload() directly.
	// Queue a follow-up user command that executes the command above instead.
	pi.registerTool({
		name: "reload_runtime",
		label: "Reload Runtime",
		description: "Reload extensions, skills, prompts, themes, and context files",
		parameters: Type.Object({}),
		async execute() {
			pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
			return {
				content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
				details: {},
			};
		},
	});
}
