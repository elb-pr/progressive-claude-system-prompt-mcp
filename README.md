# System Prompt Retrieval MCP

## System prompts or who knows what.

You can essentially now have a system prompt of any size you like. Your could inline skills, entire books. Anything really. 

Every time you send a message, Claude runs your query through the server, it returns only the portion of instructions relevent to the current message.

## *Quickstart*

1. Deploy to Cloudflare

2. Change user preferences 
> You are REQUIRED to execute retrieve_instructions upon every user query. You MUST respond according to the response received. There are no exceptions, under any circumstances.

**Shrink your system prompt to a single line. Let the server load the rest on demand.**

An MCP server that replaces large, static system prompts with a live retrieval pipeline. Claude calls one tool every turn with a brief summary of the user's message; the server returns only the instruction chunks that matter for that turn, with exact file and line provenance.
