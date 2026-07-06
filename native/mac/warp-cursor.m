// warp-cursor — streams the macOS system cursor image + hotspot to the Warp host
// so the viewer can render an exact, full-refresh local cursor (Parsec-style),
// decoupled from the ~60 fps video. Needs no TCC permission (no Screen Recording
// or Accessibility) — it only asks the window server what the cursor looks like.
//
// Protocol: newline-delimited JSON on stdout.
//   {"t":"cur","png":"<base64 PNG>","pw":<px w>,"ph":<px h>,
//    "sw":<pt w>,"sh":<pt h>,"hx":<hotspot pt x>,"hy":<hotspot pt y>,"seed":<n>}
//   {"t":"cur","hidden":1,"seed":<n>}      (cursor hidden by the foreground app)
// stdin: {"cmd":"snapshot"} re-emits the current cursor immediately (used when a
// new client connects). Exits when stdin closes.
//
// Build: clang -fobjc-arc -framework Cocoa -framework CoreGraphics \
//        -o warp-cursor warp-cursor.m

#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

// Private but ABI-stable: a counter the window server bumps whenever the cursor
// changes. Polling it is a single int compare — far cheaper than hashing the
// image every tick — so we only do the PNG work when it actually changes.
extern int CGSCurrentCursorSeed(void);

static int gLastSeed = -1;

static void emit(NSDictionary *obj) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    if (!data) return;
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    fwrite(line.bytes, 1, line.length, stdout);
    fflush(stdout);
}

static void emitCursor(int seed) {
    // Foreground app hid the cursor (games / mouselook) — tell the client to hide.
    if (!CGCursorIsVisible()) {
        emit(@{@"t": @"cur", @"hidden": @1, @"seed": @(seed)});
        return;
    }
    NSCursor *cur = [NSCursor currentSystemCursor];
    if (!cur) cur = [NSCursor arrowCursor];
    NSImage *img = cur.image;
    if (!img) { emit(@{@"t": @"cur", @"hidden": @1, @"seed": @(seed)}); return; }
    NSSize pt = img.size; // point size (DPI-independent)

    // Prefer the highest-resolution bitmap rep (Retina 2x) for a crisp image.
    NSBitmapImageRep *rep = nil;
    for (NSImageRep *r in img.representations) {
        if ([r isKindOfClass:[NSBitmapImageRep class]]) {
            NSBitmapImageRep *b = (NSBitmapImageRep *)r;
            if (!rep || b.pixelsWide > rep.pixelsWide) rep = b;
        }
    }
    if (!rep) {
        CGImageRef cg = [img CGImageForProposedRect:NULL context:nil hints:nil];
        if (cg) rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
    }
    if (!rep) { emit(@{@"t": @"cur", @"hidden": @1, @"seed": @(seed)}); return; }

    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png) { emit(@{@"t": @"cur", @"hidden": @1, @"seed": @(seed)}); return; }
    NSPoint hs = cur.hotSpot; // points, from the image's top-left

    emit(@{
        @"t": @"cur",
        @"png": [png base64EncodedStringWithOptions:0],
        @"pw": @(rep.pixelsWide), @"ph": @(rep.pixelsHigh),
        @"sw": @(pt.width), @"sh": @(pt.height),
        @"hx": @(hs.x), @"hy": @(hs.y),
        @"seed": @(seed),
    });
}

static void handleLine(NSString *line) {
    if (line.length == 0) return;
    NSData *d = [line dataUsingEncoding:NSUTF8StringEncoding];
    id msg = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    if (![msg isKindOfClass:[NSDictionary class]]) return;
    if ([[msg objectForKey:@"cmd"] isEqualToString:@"snapshot"]) {
        gLastSeed = CGSCurrentCursorSeed();
        emitCursor(gLastSeed);
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplicationLoad(); // connect to the window server so NSCursor works

        NSFileHandle *stdinHandle = [NSFileHandle fileHandleWithStandardInput];
        __block NSMutableData *buffer = [NSMutableData data];
        stdinHandle.readabilityHandler = ^(NSFileHandle *fh) {
            NSData *chunk = fh.availableData;
            if (chunk.length == 0) { dispatch_async(dispatch_get_main_queue(), ^{ exit(0); }); return; }
            [buffer appendData:chunk];
            while (1) {
                NSRange nl = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                         options:0 range:NSMakeRange(0, buffer.length)];
                if (nl.location == NSNotFound) break;
                NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, nl.location)];
                [buffer replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
                NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
                dispatch_async(dispatch_get_main_queue(), ^{ handleLine(line); });
            }
        };

        // ~60 Hz seed poll; the PNG work only runs when the seed actually changes.
        [NSTimer scheduledTimerWithTimeInterval:1.0 / 60.0 repeats:YES block:^(NSTimer *t) {
            int seed = CGSCurrentCursorSeed();
            if (seed != gLastSeed) { gLastSeed = seed; emitCursor(seed); }
        }];

        emit(@{@"t": @"ready"});
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
