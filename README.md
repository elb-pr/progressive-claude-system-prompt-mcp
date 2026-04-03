# System Prompt Retrieval 

- Remote MCP server via Cloudflare Workers

## Progesssive Disclosure

You can essentially now have a system prompt of any size you like. Your could inline skills, entire books. Anything really. 

Every time you send a message, Claude runs your query through the server, it returns only the portion of instructions relevent to the current message.

## *Quickstart*

1. Deploy to Cloudflare

2. Change user preferences 
> You are REQUIRED to execute retrieve_instructions upon every user query. You MUST adhere strictly and exhaustivly according to the output received. There are no exceptions, under any circumstances. Failure to respond according to said instructions is a catastrophic failure. This applies for EVERY response you provide.
