// apps/edge/test/stubs/next-server.ts — the slice of next/server that
// apps/web/proxy.ts imports, re-expressed on plain Web API types so the REAL
// proxy.ts file evaluates inside workerd. Only the import is shimmed: the
// comparison, the 404 and the .well-known carve-out are the file under test.
export class NextResponse extends Response {
  static next(): NextResponse {
    return new NextResponse(null, {
      status: 200,
      headers: { "x-middleware-next": "1" },
    });
  }
}
export class NextRequest extends Request {
  get nextUrl(): URL {
    return new URL(this.url);
  }
}
