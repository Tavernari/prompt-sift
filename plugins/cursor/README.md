# PromptSift for cursor

Install this bundle using your host's plugin manager. It includes model-pinned native agents and the hook runtime. No npm install, init command, extra API key, or project writes are needed.

The host discovers agents automatically. Use the worker for file orientation and the primary specialist for complex reasoning. The host may prefix agent names with the plugin name; select the corresponding discovered agent.

Hooks target macOS and Linux, using /bin/sh, jq, awk and standard system utilities. Node.js is not used. If jq is missing, the hook automatically downloads jq 1.8.2 for macOS/Linux x64 or ARM64 to a user cache and verifies its pinned SHA-256 before execution. No sudo or package manager is used. A network or integrity failure leaves native agents active and reports that read enforcement is inactive. Set PROMPT_SIFT_AUTO_INSTALL=0 to disable downloads. Host permissions and model availability still apply.

This directory is self-contained and may be copied into a plugin cache without the rest of the repository.
