/** Maximum length of a single SSE line. Protects against unbounded memory use by a hostile server. */
export const MAX_SSE_LINE_LENGTH = 1_000_000;

/**
 * Minimal Server-Sent Events reader. Yields the joined `data:` payload of each event.
 * Handles LF, CRLF, and CR line endings, including CRLF split across chunks.
 * Comment and non-data fields are ignored.
 */
export async function* sseDataEvents(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  let dataLines: string[] = [];

  for await (const chunk of chunks) {
    buffer += chunk;
    let next = nextLine(buffer);
    while (next !== undefined) {
      buffer = next.rest;
      const event = handleLine(next.line, dataLines);
      dataLines = event.dataLines;
      if (event.dispatch !== undefined) {
        yield event.dispatch;
      }
      next = nextLine(buffer);
    }
    if (buffer.length > MAX_SSE_LINE_LENGTH) {
      throw new Error("SSE line exceeds maximum length.");
    }
  }

  if (buffer.length > 0) {
    const event = handleLine(buffer, dataLines);
    dataLines = event.dataLines;
    if (event.dispatch !== undefined) {
      yield event.dispatch;
    }
  }
  if (dataLines.length > 0) {
    yield dataLines.join("\n");
  }
}

function nextLine(buffer: string): { line: string; rest: string } | undefined {
  const match = /\r\n|\r|\n/.exec(buffer);
  if (match === null) {
    return undefined;
  }
  // A lone trailing CR may be the first half of a CRLF split across chunks; wait for more input.
  if (match[0] === "\r" && match.index + 1 === buffer.length) {
    return undefined;
  }
  return { line: buffer.slice(0, match.index), rest: buffer.slice(match.index + match[0].length) };
}

function handleLine(
  line: string,
  dataLines: string[]
): { dataLines: string[]; dispatch: string | undefined } {
  if (line === "") {
    if (dataLines.length === 0) {
      return { dataLines, dispatch: undefined };
    }
    return { dataLines: [], dispatch: dataLines.join("\n") };
  }
  if (line.startsWith("data:")) {
    const value = line.slice(5);
    return { dataLines: [...dataLines, value.startsWith(" ") ? value.slice(1) : value], dispatch: undefined };
  }
  return { dataLines, dispatch: undefined };
}
