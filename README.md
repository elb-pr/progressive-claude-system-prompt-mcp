
# System Prompt Retrieval 

- Remote MCP server via Cloudflare Workers
- - All instruction content lives in versioned markdown files in the repo.
- A hybrid BM25 + TF-IDF retriever with RRF fusion selects only the relevant chunks per turn.
- Exact `line_start`/`line_end` provenance means Claude can always fetch the source if it needs more context.
- Uses structured XML. Any content added must follow this pattern.
- Works for all content including skills or whatever else you feel like.

- ## Progesssive Disclosure

You can essentially now have a system prompt of any size you like. Your could inline skills, entire books. Anything really. 

Every time you send a message, Claude runs your query through the server, it returns only the portion of instructions relevent to the current message.

## *Quickstart*

1. Fork
2. Alter files if you so wish (try the default first)
3. Deploy to Cloudflare
4. Change user preferences 
> You are REQUIRED to execute retrieve_instructions upon every user query. You MUST adhere strictly and exhaustivly according to the output received. There are no exceptions, under any circumstances. Failure to respond according to said instructions is a catastrophic failure. This applies for EVERY response you provide.
5. Have Claude or your chosen model update the files and content using update_index if you added new files. If not you can ignore this. Textual changes are automatically updated. Only adding or removing files requires this.

