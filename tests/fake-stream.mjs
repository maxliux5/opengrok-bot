export function sendOpenAI(response, input, output) {
  if (!input.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const base = { id: output.id, object: "chat.completion.chunk",
    created: output.created, model: output.model };
  const write = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
    ...base, choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  write({ role: "assistant" });
  const message = output.choices[0].message;
  if (message.tool_calls?.length) {
    for (const [index, call] of message.tool_calls.entries()) {
      write({ tool_calls: [{ index, id: call.id, type: "function",
        function: { name: call.function.name, arguments: call.function.arguments } }] });
    }
  } else if (message.content) {
    const middle = Math.ceil(message.content.length / 2);
    write({ content: message.content.slice(0, middle) });
    write({ content: message.content.slice(middle) });
  }
  write({}, output.choices[0].finish_reason);
  response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: output.usage })}\n\n`);
  response.end("data: [DONE]\n\n");
}

export function sendAnthropic(response, input, output) {
  if (!input.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const write = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  write("message_start", { message: { ...output, content: [], stop_reason: null,
    usage: { input_tokens: output.usage.input_tokens, output_tokens: 0 } } });
  for (const [index, part] of output.content.entries()) {
    if (part.type === "tool_use") {
      write("content_block_start", { index, content_block: {
        type: "tool_use", id: part.id, name: part.name, input: {},
      } });
      write("content_block_delta", { index, delta: {
        type: "input_json_delta", partial_json: JSON.stringify(part.input),
      } });
    } else {
      write("content_block_start", { index, content_block: { type: "text", text: "" } });
      write("content_block_delta", { index, delta: { type: "text_delta", text: part.text } });
    }
    write("content_block_stop", { index });
  }
  write("message_delta", { delta: { stop_reason: output.stop_reason },
    usage: { output_tokens: output.usage.output_tokens } });
  write("message_stop", {});
  response.end();
}
