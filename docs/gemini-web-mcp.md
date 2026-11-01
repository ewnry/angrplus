# Gemini Web MCP (experimental)

The local stdio server sends explicit prompts from Antigravity to a separate Gemini Web browser profile. It uses the model selected in that browser, subject to that Google account's availability and Web limits. It does not unlock models or turn Web access into an API subscription.

Cowork and the MCP server start the saved session automatically in a headless Chrome/Edge browser. No screenshots or video stream are captured. The existing Web runtime still executes Google's JavaScript; this is not a private HTTP API client. An idle hidden app polls less often than an active conversation.

For the first sign-in:

1. Open sign-in. Sign in manually in ordinary Chrome or Edge and choose the model.
2. Close the dedicated sign-in browser windows. Cowork reconnects automatically in the background; Connect in General+ is also available.
3. Check session, then Enable MCP. Refresh MCP servers in Customizations if needed.
4. Ask the agent to call `gemini_web_ask` with the desired prompt.

Only the supplied prompt is sent. Existing messages in the selected Gemini Web conversation remain part of its Web context. Local files and the Antigravity chat are not automatically attached. The browser profile lives in `~/.gemini/antigravity/gemini-web-profile`; no cookies or tokens need to be exported.

Tools: `gemini_web_open` (`mode: signin | connect`), `gemini_web_status`, `gemini_web_ask` (`prompt`). A pending browser draft is preserved. Requests are serial within a server process; interrupted, timed out or failed requests are never automatically resent. Cancellation stops waiting locally; check the browser because Web generation may continue.

## Cowork

In Claude style, Cowork opens the Gemini Web session directly. Its sidebar lists the chats currently loaded in the Web sidebar. Selecting a chat opens that actual Web conversation; New starts a new Web chat. Code retains its own chat history and draft.

The composer sends directly to the selected Web chat. Its model menu reads the real Web options, including nested reasoning levels where available. Replies use the Code chat typography and formatting; imported HTML is sanitized before rendering. Cowork drafts stay separate per Web chat during the app session. Existing drafts in the actual Web input prevent navigation or replacement.

The browser remains the source of truth. Chats and replies update while Cowork is open. Local project files and agent tools are not attached automatically.

The composer supports selecting files, clipboard images and dropped files. Attachments are reviewed as removable chips before sending. Clipboard/drop transfer is limited to 20 MB per file; selecting through the file dialog permits files up to 100 MB, subject to Gemini's own type and quota restrictions. Temporary pasted files are removed after a successful send or when removed from the composer.

Message actions appear on hover/focus, matching Code. Edit uses Gemini's native Edit and Update/Submit flow and generates a new Web reply. It may select a different Web branch according to Google's behavior.

The plus menu lists the available Web tools. Native confirmations (for example, starting a new chat for video) appear in Cowork and require the user's action. Actual tool status text and image/video/audio result cards are shown when exposed by the Web DOM. Result previews load on demand using the signed-in browser, with a 64 MB preview cap. Selecting a generation tool does not automatically spend generation quota: the user must submit a prompt.

The MCP runtime uses Antigravity's own Node runtime and needs no npm install. Enable copies two compiled modules to `~/.gemini/antigravity/mcp/gemini-web` and adds one entry to `~/.gemini/config/mcp_config.json`, preserving other entries. Disable removes that entry and retains the browser profile. Re-enable after updating the patcher to refresh the copied runtime.

Browser selectors can change when Google updates Gemini. Sign-in challenges and provider errors are reported; the bridge does not solve them. If Google refuses login, use Open sign-in without debugging first. Never paste account passwords or session cookies into chat.
