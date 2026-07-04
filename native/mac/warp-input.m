// warp-input — injects mouse/keyboard events on macOS via CGEvent.
// Requires Accessibility permission for the parent app.
//
// Protocol: newline-delimited JSON on stdin. Events:
//   {"t":"mm","d":<displayId>,"x":0..1,"y":0..1}        absolute move within display
//   {"t":"md","b":0|1|2}                                 mouse down (0=left,1=middle,2=right)
//   {"t":"mu","b":0|1|2}                                 mouse up
//   {"t":"sc","dx":<px>,"dy":<px>}                       scroll (pixel deltas)
//   {"t":"kd","k":<macKeycode>,"r":0|1}                  key down (r = autorepeat)
//   {"t":"ku","k":<macKeycode>}                          key up
//   {"t":"txt","s":"literal text"}                       type unicode text
//
// Modifier state (shift/ctrl/alt/cmd) is tracked from kd/ku of modifier
// keycodes and applied as CGEventFlags on every synthesized event so that
// shortcuts like Cmd+C work.
//
// Build: clang -fobjc-arc -framework Foundation -framework CoreGraphics \
//        -o warp-input warp-input.m

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>

static CGPoint gPos = {100, 100};
static BOOL gButtonDown[3] = {NO, NO, NO}; // left, middle, right
static CGEventFlags gFlags = 0;
static int gClickCount = 1;
static NSTimeInterval gLastClickTime = 0;
static CGPoint gLastClickPos = {0, 0};

// Mac virtual keycodes for modifiers
#define VK_SHIFT 56
#define VK_RSHIFT 60
#define VK_CONTROL 59
#define VK_RCONTROL 62
#define VK_OPTION 58
#define VK_ROPTION 61
#define VK_COMMAND 55
#define VK_RCOMMAND 54
#define VK_CAPSLOCK 57
#define VK_FN 63

static void updateFlags(int keycode, BOOL down) {
    CGEventFlags bit = 0;
    switch (keycode) {
        case VK_SHIFT: case VK_RSHIFT:     bit = kCGEventFlagMaskShift; break;
        case VK_CONTROL: case VK_RCONTROL: bit = kCGEventFlagMaskControl; break;
        case VK_OPTION: case VK_ROPTION:   bit = kCGEventFlagMaskAlternate; break;
        case VK_COMMAND: case VK_RCOMMAND: bit = kCGEventFlagMaskCommand; break;
        case VK_FN:                        bit = kCGEventFlagMaskSecondaryFn; break;
        default: return;
    }
    if (down) gFlags |= bit; else gFlags &= ~bit;
}

static void postMouse(CGEventType type, CGMouseButton button) {
    CGEventRef ev = CGEventCreateMouseEvent(NULL, type, gPos, button);
    CGEventSetFlags(ev, gFlags);
    if (type != kCGEventMouseMoved && type != kCGEventScrollWheel) {
        CGEventSetIntegerValueField(ev, kCGMouseEventClickState, gClickCount);
    }
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
}

static void handleMove(NSDictionary *m) {
    CGDirectDisplayID displayId = [m[@"d"] unsignedIntValue];
    double nx = [m[@"x"] doubleValue], ny = [m[@"y"] doubleValue];
    CGRect bounds = CGDisplayBounds(displayId);
    if (CGRectIsEmpty(bounds)) bounds = CGDisplayBounds(CGMainDisplayID());
    gPos.x = bounds.origin.x + nx * bounds.size.width;
    gPos.y = bounds.origin.y + ny * bounds.size.height;

    CGEventType type = kCGEventMouseMoved;
    CGMouseButton btn = kCGMouseButtonLeft;
    if (gButtonDown[0])      { type = kCGEventLeftMouseDragged;  btn = kCGMouseButtonLeft; }
    else if (gButtonDown[2]) { type = kCGEventRightMouseDragged; btn = kCGMouseButtonRight; }
    else if (gButtonDown[1]) { type = kCGEventOtherMouseDragged; btn = kCGMouseButtonCenter; }
    postMouse(type, btn);
}

static void handleButton(NSDictionary *m, BOOL down) {
    int b = [m[@"b"] intValue];
    if (b < 0 || b > 2) return;
    gButtonDown[b] = down;

    if (down) {
        NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
        double dx = gPos.x - gLastClickPos.x, dy = gPos.y - gLastClickPos.y;
        if (now - gLastClickTime < 0.4 && dx * dx + dy * dy < 25) gClickCount++;
        else gClickCount = 1;
        gLastClickTime = now;
        gLastClickPos = gPos;
    }

    CGEventType type;
    CGMouseButton btn;
    if (b == 0)      { type = down ? kCGEventLeftMouseDown  : kCGEventLeftMouseUp;  btn = kCGMouseButtonLeft; }
    else if (b == 2) { type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp; btn = kCGMouseButtonRight; }
    else             { type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp; btn = kCGMouseButtonCenter; }
    postMouse(type, btn);
}

static void handleScroll(NSDictionary *m) {
    int dx = [m[@"dx"] intValue], dy = [m[@"dy"] intValue];
    CGEventRef ev = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, -dy, -dx);
    CGEventSetFlags(ev, gFlags);
    CGEventSetLocation(ev, gPos);
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
}

static void handleKey(NSDictionary *m, BOOL down) {
    int keycode = [m[@"k"] intValue];
    if (keycode < 0 || keycode > 0xFFFF) return;
    updateFlags(keycode, down);
    CGEventRef ev = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keycode, down);
    CGEventSetFlags(ev, gFlags);
    if (down && [m[@"r"] boolValue]) {
        CGEventSetIntegerValueField(ev, kCGKeyboardEventAutorepeat, 1);
    }
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
}

static void handleText(NSDictionary *m) {
    NSString *s = m[@"s"];
    if (![s isKindOfClass:[NSString class]] || s.length == 0) return;
    // Type in chunks; each event carries the unicode payload.
    NSUInteger i = 0;
    while (i < s.length) {
        NSUInteger len = MIN((NSUInteger)20, s.length - i);
        // Don't split surrogate pairs
        if (i + len < s.length &&
            CFStringIsSurrogateHighCharacter([s characterAtIndex:i + len - 1])) len--;
        NSString *chunk = [s substringWithRange:NSMakeRange(i, len)];
        unichar buf[64];
        [chunk getCharacters:buf range:NSMakeRange(0, chunk.length)];
        CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
        CGEventKeyboardSetUnicodeString(down, chunk.length, buf);
        CGEventPost(kCGHIDEventTap, down);
        CFRelease(down);
        CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
        CGEventKeyboardSetUnicodeString(up, chunk.length, buf);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(up);
        i += len;
    }
}

static void handleLine(NSData *lineData) {
    NSDictionary *m = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:nil];
    if (![m isKindOfClass:[NSDictionary class]]) return;
    NSString *t = m[@"t"];
    if ([t isEqualToString:@"mm"])       handleMove(m);
    else if ([t isEqualToString:@"md"])  handleButton(m, YES);
    else if ([t isEqualToString:@"mu"])  handleButton(m, NO);
    else if ([t isEqualToString:@"sc"])  handleScroll(m);
    else if ([t isEqualToString:@"kd"])  handleKey(m, YES);
    else if ([t isEqualToString:@"ku"])  handleKey(m, NO);
    else if ([t isEqualToString:@"txt"]) handleText(m);
    else if ([t isEqualToString:@"reset"]) {
        // Release everything (client disconnected mid-drag / mid-keypress)
        for (int b = 0; b < 3; b++) {
            if (gButtonDown[b]) {
                NSDictionary *up = @{@"b": @(b)};
                handleButton(up, NO);
            }
        }
        gFlags = 0;
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (!AXIsProcessTrusted()) {
            fprintf(stderr, "warning: accessibility permission not granted\n");
        }
        NSMutableData *buffer = [NSMutableData data];
        char chunk[4096];
        ssize_t n;
        printf("{\"ok\":true,\"ready\":true}\n");
        fflush(stdout);
        while ((n = read(STDIN_FILENO, chunk, sizeof(chunk))) > 0) {
            [buffer appendBytes:chunk length:(NSUInteger)n];
            while (1) {
                NSRange nl = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                         options:0
                                           range:NSMakeRange(0, buffer.length)];
                if (nl.location == NSNotFound) break;
                NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, nl.location)];
                [buffer replaceBytesInRange:NSMakeRange(0, nl.location + 1)
                                  withBytes:NULL length:0];
                @autoreleasepool { handleLine(lineData); }
            }
        }
    }
    return 0;
}
