# SAMI Estofados — WHAPI.Cloud Status MCP bridge

This is an **isolated remote MCP server** for Composio. It uses only the existing official WHAPI.Cloud API and never connects to WhatsApp Web, Meta's WhatsApp API, or another provider.

**Tools:** `whapi_check_channel`, `whapi_list_stories`, `whapi_get_story`, `whapi_publish_status_media`. The Status tool sends **one live media frame** using `POST https://gate.whapi.cloud/stories/send/media` only when `confirm_publish: true`.

## Configure Composio

1. Add a Custom MCP toolkit with URL `https://sami-whapi-composio-mcp.onrender.com/mcp`.
2. Select `API_KEY` authentication; header mapping `Authorization: Bearer {{generic_api_key}}`.
3. Connect the **existing WHAPI channel token**, inside Composio's credentials vault (not in the URL, chat, repository or service).
4. Sync and verify all **four** MCP tools are visible. Existing uploaded toolkit with zero tools can stay unchanged until new toolkit is validated; do not delete it blindly.

If your existing custom Whapi toolkit uses an incorrect MCP URL, Composio's docs state its `mcp_url` cannot be changed. Create a new custom toolkit with this valid endpoint. No re-pairing of WhatsApp is required.

## Deployment

Source is in a dedicated Git branch and does not touch the production VEREDA repository or the private Whapi Site.

- Render repo: `enthony1306/jarvis-estofados`.
- Branch: `feat/whapi-composio-mcp-bridge`.
- Runtime: `node`.
- Build: `node --check integrations/sami-whapi-mcp/server.mjs`.
- Start: `node integrations/sami-whapi-mcp/server.mjs`.
- No secrets configured at Render; Composio transmits the saved channel credential as Bearer on each authenticated MCP tool call.

## Operational limits

- No built-in scheduler, persistent database or media storage. A separate reliable 18h scheduler must refresh media URLs, check for duplicate statuses, call the tool, persist the resulting story ID in Trello, and verify it using `whapi_get_story`.
- The in-process idempotency map is **not durable**. Render free instances sleep and lose memory. Never retry an ambiguous status send without first reconciling via `whapi_list_stories`.
- Provider `AUTH` does not prove the Status post succeeded. After any live publish verify the provider ID and media.
- Use HTTPS URLs that the WHAPI servers can actually download when publishing; signed short-lived URLs need to be renewed before each scheduled job.
- Do not change the existing Whapi private Site, token or webhook setup.
- `GET /health` checks only this MCP server without exposing token.

### Security

No channel token is stored or logged in bridge source, environment or disk. Only fixed allowlisted WHAPI gateway paths are contacted. No ordinary WhatsApp message/group tools are exposed. There is no public unauthenticated publish endpoint.
