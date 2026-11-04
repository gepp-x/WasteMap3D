// macOS-only helper: extract the text layer of a PDF with Apple PDFKit (no third-party code).
// Usage: osascript -l JavaScript scripts/data/lib/pdf-to-text.jxa.js <in.pdf> <out.txt>
// Pages are separated by "=====PAGE n=====" marker lines (1-based PDF page index).
ObjC.import("PDFKit");
ObjC.import("Foundation");

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JXA entry point, invoked by osascript
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc || doc.isNil()) throw new Error("PDFKit could not open " + argv[0]);
  var n = doc.pageCount;
  var out = [];
  for (var i = 0; i < n; i++) {
    var p = doc.pageAtIndex(i);
    out.push("=====PAGE " + (i + 1) + "=====\n" + ObjC.unwrap(p.string));
  }
  var s = $.NSString.alloc.initWithUTF8String(out.join("\n"));
  s.writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null);
  return "pages " + n;
}
