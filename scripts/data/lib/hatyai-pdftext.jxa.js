// Extract the text layer of a PDF with macOS PDFKit (read-only; never executes the PDF).
// Usage: osascript -l JavaScript scripts/data/lib/hatyai-pdftext.jxa.js /abs/path/file.pdf
// Output: "PAGES:<n>" then "=== page <i>" blocks (UTF-8). Used by scripts/data/fetch-hatyai.ts.
ObjC.import('Foundation');
ObjC.import('PDFKit');
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JXA entry point, invoked by osascript
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) { throw new Error('cannot open PDF: ' + argv[0]); }
  var n = doc.pageCount;
  var parts = ['PAGES:' + n];
  for (var i = 0; i < n; i++) {
    var s = doc.pageAtIndex(i).string;
    parts.push('=== page ' + (i + 1));
    parts.push(s && !s.isNil() ? ObjC.unwrap(s) : '');
  }
  return parts.join('\n');
}
