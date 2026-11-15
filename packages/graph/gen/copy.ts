import type pg from 'pg';

// Minimal `COPY … FROM STDIN` for node-postgres without an extra dependency: a Submittable that answers the
// server's CopyInResponse by streaming text-format rows over the client's connection (what pg-copy-streams does).

/** COPY text format: tab-separated, \N = NULL, backslash escapes. */
export function copyValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  if (typeof v !== 'string') return String(v);
  return /[\\\t\n\r]/.test(v) ? v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r') : v;
}

export type Row = readonly (string | number | boolean | null | undefined)[];

interface Conn {
  query(text: string): void;
  sendCopyFromChunk(chunk: Buffer): void;
  endCopyFrom(): void;
  sendCopyFail(msg: string): void;
  stream: NodeJS.WritableStream & { writableNeedDrain?: boolean };
}

class CopyIn {
  private resolve!: (n: number) => void;
  private reject!: (e: Error) => void;
  private error: Error | null = null;
  private rowCount = 0;
  readonly done: Promise<number>;

  constructor(
    private readonly text: string,
    private readonly rows: Iterable<Row>,
  ) {
    this.done = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  submit(connection: Conn) {
    connection.query(this.text);
  }

  handleCopyInResponse(connection: Conn) {
    void this.pump(connection);
  }

  private async pump(c: Conn) {
    try {
      let buf: string[] = [];
      let size = 0;
      for (const row of this.rows) {
        if (this.error) {
          c.sendCopyFail('aborted after server error'); // server is discarding data until CopyDone / CopyFail
          return;
        }
        const line = row.map(copyValue).join('\t') + '\n';
        buf.push(line);
        size += line.length;
        if (size > 1 << 20) {
          c.sendCopyFromChunk(Buffer.from(buf.join(''), 'utf8'));
          buf = [];
          size = 0;
          if (c.stream.writableNeedDrain) await new Promise((r) => c.stream.once('drain', r));
        }
      }
      if (buf.length) c.sendCopyFromChunk(Buffer.from(buf.join(''), 'utf8'));
      c.endCopyFrom();
    } catch (e) {
      c.sendCopyFail(e instanceof Error ? e.message : String(e));
    }
  }

  handleCommandComplete(msg: { text?: string }) {
    this.rowCount = Number(/(\d+)$/.exec(msg.text ?? '')?.[1] ?? 0);
  }

  // pg clears the active query on ErrorResponse, so ReadyForQuery never reaches us after an error: settle here
  handleError(e: Error) {
    this.error = e;
    this.reject(e);
  }

  handleReadyForQuery() {
    if (this.error) this.reject(this.error);
    else this.resolve(this.rowCount);
  }

  // protocol messages a COPY never produces — present so the client does not crash on unexpected input
  handleRowDescription() {}
  handleDataRow() {}
  handlePortalSuspended() {}
  handleEmptyQuery() {}
  handleCopyData() {}
}

/** Streams `rows` into `table (columns)`; resolves with the number of copied rows. */
export async function copyRows(client: pg.Client, table: string, columns: readonly string[], rows: Iterable<Row>): Promise<number> {
  const op = new CopyIn(`COPY ${table} (${columns.join(', ')}) FROM STDIN`, rows);
  client.query(op as unknown as pg.Submittable);
  return op.done;
}
