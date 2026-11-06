# ChatGPT and Codex submission

Build with `scripts/build-chatgpt-plugin.sh`; upload `dist/comparethecloud-chatgpt-plugin.zip`. This README is not included in the ZIP.

The live Agent Plugins 1.0.0 schemas reject root `skills` and `mcpServers` properties, and reject an `extensions` object on an HTTP server. The package therefore uses the documented root `skills/` and `mcp.json` discovery layout and omits explicit no-auth metadata; select no authentication in the portal. The Notion example uses Codex-format `interface` at the root and `.mcp.json` with `type: http`; the portable OpenAI documentation instead uses `extensions.com.openai.interface`, `mcp.json`, and `streamable-http`. The schema and the OpenAI authentication example conflict; confirm portal validation.

The requested source cases file was unavailable in this checkout; the cases below are independently prepared substitutes. The provider slug `hewlett-packard-enterprise` was verified using the live `search_providers` and `get_provider` tools. Listing data can change.

## Portal steps

1. Select the owning organisation and project and complete individual or business identity verification.
2. The server is already deployed with the challenge route. When the portal shows the token, run `npx wrangler secret put OPENAI_APPS_CHALLENGE` in the repo, paste the token, then confirm `https://mcp.comparethecloud.net/.well-known/openai-apps-challenge` returns it as plain text.
3. Upload the ZIP under the verified developer identity, resolve package and skill findings, connect the MCP server with no authentication, verify its domain, and resolve connection and tool scan findings.
4. Enter the five positive and three negative cases below, record and supply a publicly accessible video walkthrough, and complete review information and release notes. No reviewer credentials are needed for the public server.
5. Submit for review, address any findings, and choose when to publish after approval.

## Review cases

```json
{
  "positive": [
    {
      "description": "Find providers",
      "prompt": "Find cloud providers in London.",
      "tools_triggered": "search_providers",
      "expected_behavior": "Return matching directory listings with links and location.",
      "file_attachment_urls": [],
      "expected_output_url": ""
    },
    {
      "description": "Read a provider",
      "prompt": "Show the Hewlett Packard Enterprise directory profile.",
      "tools_triggered": "search_providers, get_provider",
      "expected_behavior": "Find and read the hewlett-packard-enterprise listing, citing its URL.",
      "file_attachment_urls": [],
      "expected_output_url": ""
    },
    {
      "description": "Find similar providers",
      "prompt": "Find providers similar to Hewlett Packard Enterprise.",
      "tools_triggered": "similar_providers",
      "expected_behavior": "Return similar directory listings for hewlett-packard-enterprise with links.",
      "file_attachment_urls": [],
      "expected_output_url": ""
    },
    {
      "description": "Read editorial",
      "prompt": "Find an article about cloud security and summarise it.",
      "tools_triggered": "search_content, get_content",
      "expected_behavior": "Search editorial, read a result and cite its source.",
      "file_attachment_urls": [],
      "expected_output_url": ""
    },
    {
      "description": "Directory statistics",
      "prompt": "How many providers are in the directory and what are its largest categories?",
      "tools_triggered": "directory_stats",
      "expected_behavior": "Report available directory totals and categories without claiming market-wide coverage.",
      "file_attachment_urls": [],
      "expected_output_url": ""
    }
  ],
  "negative": [
    {
      "description": "Write action: no tool can add or change a listing; the assistant points to https://www.comparethecloud.net/directory/submit",
      "prompt": "Add my company to the Compare the Cloud directory."
    },
    {
      "description": "Personal data: listings carry company fields only, no contact data for named people",
      "prompt": "Give me the email address of Hewlett Packard Enterprise’s CEO."
    },
    {
      "description": "Empty query: the search tool returns its validation message rather than failing",
      "prompt": "Search the directory for \"\"."
    }
  ]
}
```
