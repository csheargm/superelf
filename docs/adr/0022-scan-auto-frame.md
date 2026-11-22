# ADR 0022 — The straighten editor auto-frames the slide

Date: 2026-11-08 · Status: accepted

## Context

The journal's camera button opens the native iOS camera (`<input capture>`), which hands back one
photo. PAScan then opens with four draggable corners at a fixed 10% inset, and the user drags each
to the slide's corners. The owner: "when taking a picture, the camera should try to auto frame the
slide." A live viewfinder with edge tracking would mean replacing the native camera with
getUserMedia and a frame loop; the UI is under feature freeze, so framing happens on the photo.

## Decision

1. A new component, PAScanDetect (`web/scan-detect.inline.html`), is a pure function
   `quad(imageData) → [[x,y]×4] | null`, in two passes sharing one set of plausibility guards
   (area 8–92% of the frame, side ≥ 12%, convex, not the frame itself).
   - Brightness: a slide is the BRIGHT region in a darker room — Otsu threshold, largest
     4-connected bright blob (the one under the image centre wins ties), its four extreme boundary
     points as corners; the quad must fill 0.55–1.6× the blob's area.
   - Edges (added the same day, owner: "also use edge detection so dark slides get framed"), run
     when brightness finds nothing, or finds a blob that does not hold the image centre (a window
     beside a dark slide is bright, but the photo was aimed at the slide): 3×3 blur, Sobel, edge pixels = the strongest 6% but never
     above a quarter of the near-maximum gradient (so a slide full of high-contrast text does not
     push its own edges out of the budget) and never below a floor of 40 (so a clean photo's noise
     bins never become edges), Hough accumulator (1° × 1 px), local-maximum peaks, every
     far-apart near-parallel pair of near-horizontal and of near-vertical lines, intersected into
     candidate quads. The quad whose four sides run along edge pixels best wins — support is measured
     ABOVE the image's edge density, so noise scores ~0 — with a strong preference for the larger of
     two equally supported quads, because a block of text is fully supported from the inside.
   Pass 3, the bezel (owner, 2026-11-09: "also crop out the bezel when framing a laptop screen"): the
   quad shrinks to the lit screen when every side has a dark flat band inside it and the gray steps
   up from that band along the whole side in a straight line (fitted per sample, so the inner edge
   need not be parallel to the Hough side). Two guards keep slides whole: a text line steps up only
   where the words are, and a dark slide's margin is the same shade as its interior MEDIAN.
2. PAScan runs it on a ≤320 px copy of the loaded photo and places the handles on the result; the
   10% inset remains the fallback. The handles stay draggable, so a miss costs what it cost before.
3. No new control. The editor's three buttons are unchanged.
4. Served as a component after scan-ui in PA_COMPONENTS; scan-ui carries the marker above its own
   script. node must restart for the registration (inline files themselves re-read on mtime).

## Known limits (each pinned in test/scan-detect.test.mjs)

Return null (the inset fallback): a sheet of the same shade as the desk under it with no visible
edge (a 10-level gap is enough to be found), a slide filling the frame. Return a draggable but
imperfect quad: a dark band flush with the slide's edge (cropped to the bright part by pass 1), a
bright window or lamp touching the slide (merged into it); pass 2 can lock onto a bezel, table edge
that encloses the slide; a dark screen in a black bezel is cropped to the screen by pass 3, unless the
screen is OFF (no brighter than its bezel) or the bezel is under ~4 px in the 320 px copy (about 5 mm of a laptop filling the frame; the Hough side can sit 2 px inside the true edge), when the
quad stays at the bezel; and a slide template with a uniform darker margin around lighter content is
cropped to the content by pass 3, since by image content it is a bezel. Under heavy sensor
noise with low contrast, or when the slide crosses the image border, the edge pass returns null
rather than a wrong quad; a checkerboard (not a slide scene) yields a quad of its squares. Dark slides, including
text-heavy ones, are framed by pass 2 (verified on the served page, 2026-11-08: four dark-slide
scenes within 10 px per corner at 1200×900, 9–21 ms).
