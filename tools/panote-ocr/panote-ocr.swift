// panote-ocr — local text recognition for PANote pages (docs/plans/note-search.md phase 2, ADR 0023).
// Apple Vision on the Mac node; nothing leaves the machine. Compiled by lib/note-ocr.mjs ensureBuilt
// (`swiftc -O`) into tools/panote-ocr/build/, which is gitignored.
//
//   panote-ocr ink <strokes.json> [widthPx]   strokes = [{c,w,t,p:[[x,y,pressure],...]}], coordinates
//                                             normalised by the page WIDTH (y too); `t:"highlighter"`
//                                             strokes are skipped; rendered black on white, polyline,
//                                             round caps, stroke width w*W.
//   panote-ocr image <file>                   text recognition + image labels (VNClassifyImageRequest)
//   panote-ocr text <string> <out.png>        DEBUG: render printed text to a PNG (the real-Vision test
//                                             feeds it back through `image`, so no fixture image is
//                                             committed).
// Env: OCR_LANGS = comma list of recognition languages (default "zh-Hans,en-US"); OCR_NOCORR disables
// Vision's language correction (measured: no difference on real pages).
// Output: ONE JSON line on stdout, always, even on failure:
//   {ok:true, ms, text:[{t,c,box:[x,y,w,h]}], labels:[{l,c}]}   box normalised, origin top-left
//   {ok:false, error}                                            exit code 1
import Foundation
import Vision
import AppKit

struct Stroke: Decodable { let c: String?; let w: Double?; let t: String?; let p: [[Double]] }

let DEFAULT_WIDTH = 1600            // measured 2026-11-09: 2400 px recognised no better, took longer
let MIN_LABEL_CONFIDENCE: Float = 0.3
let MAX_PAGE_HEIGHT_RATIO = 6.0     // a page taller than 6x its width is cut: a runaway stroke must not allocate a huge bitmap

func jsonString(_ s: String) -> String {
  let d = try! JSONSerialization.data(withJSONObject: [s], options: [])
  let arr = String(data: d, encoding: .utf8)!
  return String(arr.dropFirst().dropLast())
}
func fail(_ msg: String) -> Never { print("{\"ok\":false,\"error\":\(jsonString(msg))}"); exit(1) }

func renderInk(_ strokes: [Stroke], width: Int) -> CGImage? {
  var maxY = 0.0
  for s in strokes { for pt in s.p where pt.count >= 2 { maxY = max(maxY, pt[1]) } }
  let W = Double(width), H = max(W * 0.3, min(W * maxY + W * 0.05, W * MAX_PAGE_HEIGHT_RATIO))
  guard let ctx = CGContext(data: nil, width: width, height: Int(H), bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
  ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  ctx.setStrokeColor(gray: 0, alpha: 1); ctx.setFillColor(gray: 0, alpha: 1)
  ctx.setLineCap(.round); ctx.setLineJoin(.round)
  for s in strokes where s.t != "highlighter" {
    let base = max(1.5, (s.w ?? 0.003) * W)
    let pts = s.p.filter { $0.count >= 2 }.map { CGPoint(x: $0[0] * W, y: H - $0[1] * W) }   // CG y is up
    if pts.isEmpty { continue }
    if pts.count == 1 { ctx.fillEllipse(in: CGRect(x: pts[0].x - base / 2, y: pts[0].y - base / 2, width: base, height: base)); continue }
    ctx.setLineWidth(base); ctx.beginPath(); ctx.move(to: pts[0])
    for p in pts.dropFirst() { ctx.addLine(to: p) }
    ctx.strokePath()
  }
  return ctx.makeImage()
}

// DEBUG `text` mode: printed text on a white 1200x300 bitmap, saved as PNG.
func renderText(_ s: String, to file: String) {
  let img = NSImage(size: NSSize(width: 1200, height: 300)); img.lockFocus()
  NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1200, height: 300).fill()
  let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 48), .foregroundColor: NSColor.black]
  (s as NSString).draw(at: NSPoint(x: 40, y: 120), withAttributes: attrs)
  img.unlockFocus()
  guard let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { fail("cannot encode png") }
  do { try png.write(to: URL(fileURLWithPath: file)) } catch { fail("cannot write \(file): \(error)") }
}

func recognise(_ cg: CGImage, labels: Bool) -> (text: [[String: Any]], labels: [[String: Any]]) {
  let env = ProcessInfo.processInfo.environment
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = env["OCR_NOCORR"] == nil
  req.recognitionLanguages = (env["OCR_LANGS"] ?? "zh-Hans,en-US").split(separator: ",").map(String.init)
  var reqs: [VNRequest] = [req]
  let cls = VNClassifyImageRequest()
  if labels { reqs.append(cls) }
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform(reqs) } catch { fail("vision: \(error)") }
  var text: [[String: Any]] = []
  for o in (req.results ?? []) {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox   // normalised, origin bottom-left → top-left
    text.append(["t": c.string, "c": Double(round(c.confidence * 100) / 100),
                 "box": [b.minX, 1 - b.maxY, b.width, b.height].map { Double(round($0 * 1000) / 1000) }])
  }
  var labs: [[String: Any]] = []
  if labels { for o in (cls.results ?? []) where o.confidence >= MIN_LABEL_CONFIDENCE { labs.append(["l": o.identifier, "c": Double(round(o.confidence * 100) / 100)]) } }
  return (text, labs)
}

let t0 = Date()
let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: panote-ocr ink <strokes.json> [width] | image <file> | text <string> <out.png>") }
var cg: CGImage?
var wantLabels = false
switch args[1] {
case "ink":
  guard let data = FileManager.default.contents(atPath: args[2]) else { fail("cannot read strokes") }
  guard let strokes = try? JSONDecoder().decode([Stroke].self, from: data) else { fail("strokes are not [{p:[[x,y,p]]}]") }
  let width = args.count >= 4 ? (Int(args[3]) ?? DEFAULT_WIDTH) : DEFAULT_WIDTH
  guard width >= 100 && width <= 4000 else { fail("width out of range") }
  cg = renderInk(strokes, width: width)
case "image":
  guard let img = NSImage(contentsOfFile: args[2]) else { fail("cannot read image") }
  cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil); wantLabels = true
case "text":
  guard args.count >= 4 else { fail("usage: panote-ocr text <string> <out.png>") }
  renderText(args[2], to: args[3])
  print("{\"ok\":true,\"ms\":\(Int(Date().timeIntervalSince(t0) * 1000)),\"text\":[],\"labels\":[]}")
  exit(0)
default:
  fail("unknown mode \(args[1])")
}
guard let image = cg else { fail("no image") }
let r = recognise(image, labels: wantLabels)
let out: [String: Any] = ["ok": true, "ms": Int(Date().timeIntervalSince(t0) * 1000), "text": r.text, "labels": r.labels]
guard let json = try? JSONSerialization.data(withJSONObject: out, options: []) else { fail("cannot encode result") }
print(String(data: json, encoding: .utf8)!)
