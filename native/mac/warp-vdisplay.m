// warp-vdisplay — creates virtual displays on macOS using the private
// CGVirtualDisplay API (the same mechanism used by virtual-display tools).
// Displays exist for the lifetime of this process.
//
// Protocol: newline-delimited JSON on stdin, responses on stdout.
//   {"cmd":"create","width":2560,"height":1440,"hz":60,"hidpi":1,"name":"Warp 1"}
//     -> {"ok":true,"token":1,"displayId":885161279}
//   {"cmd":"destroy","token":1}         -> {"ok":true}
//   {"cmd":"list"}                      -> {"ok":true,"displays":[...]}
//
// Build: clang -fobjc-arc -framework Foundation -framework CoreGraphics \
//        -o warp-vdisplay warp-vdisplay.m

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

// ---- Private CoreGraphics API declarations (names are part of the OS ABI) ----

@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic, strong) NSArray *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic, strong) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int serialNum;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, copy) void (^terminationHandler)(id sender, id display);
@end

@interface CGVirtualDisplayMode : NSObject
@property(nonatomic, readonly) unsigned int width;
@property(nonatomic, readonly) unsigned int height;
@property(nonatomic, readonly) double refreshRate;
- (instancetype)initWithWidth:(unsigned int)width
                       height:(unsigned int)height
                  refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplay : NSObject
@property(nonatomic, readonly) unsigned int displayID;
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@end

// -----------------------------------------------------------------------------

static NSMutableDictionary<NSNumber *, CGVirtualDisplay *> *gDisplays;
static int gNextToken = 1;

static void emit(NSDictionary *obj) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    fwrite(line.bytes, 1, line.length, stdout);
    fflush(stdout);
}

static void unmirrorAll(void) {
    CGDirectDisplayID online[16];
    uint32_t count = 0;
    if (CGGetOnlineDisplayList(16, online, &count) != kCGErrorSuccess) return;

    BOOL anyMirrored = NO;
    for (uint32_t i = 0; i < count; i++) {
        if (CGDisplayIsInMirrorSet(online[i])) { anyMirrored = YES; break; }
    }
    if (!anyMirrored) return;

    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) return;
    for (uint32_t i = 0; i < count; i++) {
        CGConfigureDisplayMirrorOfDisplay(config, online[i], kCGNullDirectDisplay);
    }
    CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
}

static void handleCreate(NSDictionary *msg) {
    unsigned int width  = [msg[@"width"] unsignedIntValue];
    unsigned int height = [msg[@"height"] unsignedIntValue];
    double hz           = msg[@"hz"] ? [msg[@"hz"] doubleValue] : 60.0;
    BOOL hidpi          = [msg[@"hidpi"] boolValue];
    NSString *name      = msg[@"name"] ?: @"Warp Display";
    id reqId            = msg[@"id"] ?: [NSNull null];

    if (width < 640 || height < 480 || width > 8192 || height > 8192) {
        emit(@{@"ok": @NO, @"id": reqId, @"error": @"invalid resolution"});
        return;
    }

    CGVirtualDisplayDescriptor *desc = [[CGVirtualDisplayDescriptor alloc] init];
    desc.name = name;
    desc.maxPixelsWide = hidpi ? width * 2 : width;
    desc.maxPixelsHigh = hidpi ? height * 2 : height;
    // Physical size derived from ~109 PPI (typical desktop monitor) so macOS
    // picks a sensible default scaling.
    double ppi = 109.0;
    desc.sizeInMillimeters = CGSizeMake(25.4 * width / ppi, 25.4 * height / ppi);
    desc.serialNum = (unsigned int)(0x57415250 + gNextToken); // 'WARP' + n
    desc.productID = 0x5741;
    desc.vendorID  = 0x5250;
    desc.queue = dispatch_get_main_queue();
    desc.terminationHandler = ^(id sender, id display) {
        // Display torn down by the system; nothing to do, tracked via tokens.
    };

    CGVirtualDisplay *disp = [[CGVirtualDisplay alloc] initWithDescriptor:desc];
    if (!disp) {
        emit(@{@"ok": @NO, @"id": reqId, @"error": @"CGVirtualDisplay init failed"});
        return;
    }

    CGVirtualDisplaySettings *settings = [[CGVirtualDisplaySettings alloc] init];
    settings.hiDPI = hidpi ? 1 : 0;
    NSMutableArray *modes = [NSMutableArray array];
    if (hidpi) {
        [modes addObject:[[CGVirtualDisplayMode alloc] initWithWidth:width * 2
                                                              height:height * 2
                                                         refreshRate:hz]];
    }
    [modes addObject:[[CGVirtualDisplayMode alloc] initWithWidth:width
                                                          height:height
                                                     refreshRate:hz]];
    settings.modes = modes;

    if (![disp applySettings:settings]) {
        emit(@{@"ok": @NO, @"id": reqId, @"error": @"applySettings failed"});
        return;
    }

    int token = gNextToken++;
    gDisplays[@(token)] = disp;

    // macOS often brings a new virtual display up mirrored with an existing
    // one. Wait for it to come online, then break every mirror pair so the
    // virtual display extends the desktop instead.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        unmirrorAll();
        emit(@{@"ok": @YES,
               @"id": reqId,
               @"token": @(token),
               @"displayId": @(disp.displayID),
               @"width": @(width),
               @"height": @(height)});
    });
}

static void handleDestroy(NSDictionary *msg) {
    NSNumber *token = msg[@"token"];
    id reqId = msg[@"id"] ?: [NSNull null];
    if (token && gDisplays[token]) {
        [gDisplays removeObjectForKey:token]; // releasing tears the display down
        emit(@{@"ok": @YES, @"id": reqId});
    } else {
        emit(@{@"ok": @NO, @"id": reqId, @"error": @"unknown token"});
    }
}

static void handleList(NSDictionary *msg) {
    NSMutableArray *list = [NSMutableArray array];
    [gDisplays enumerateKeysAndObjectsUsingBlock:^(NSNumber *tok, CGVirtualDisplay *d, BOOL *stop) {
        [list addObject:@{@"token": tok, @"displayId": @(d.displayID)}];
    }];
    emit(@{@"ok": @YES, @"id": msg[@"id"] ?: [NSNull null], @"displays": list});
}

static void handleLine(NSString *line) {
    if (line.length == 0) return;
    NSError *err = nil;
    NSDictionary *msg = [NSJSONSerialization
        JSONObjectWithData:[line dataUsingEncoding:NSUTF8StringEncoding]
                   options:0 error:&err];
    if (![msg isKindOfClass:[NSDictionary class]]) {
        emit(@{@"ok": @NO, @"error": @"bad json"});
        return;
    }
    NSString *cmd = msg[@"cmd"];
    if ([cmd isEqualToString:@"create"])       handleCreate(msg);
    else if ([cmd isEqualToString:@"destroy"]) handleDestroy(msg);
    else if ([cmd isEqualToString:@"list"])    handleList(msg);
    else if ([cmd isEqualToString:@"ping"])    emit(@{@"ok": @YES, @"id": msg[@"id"] ?: [NSNull null], @"pong": @YES});
    else emit(@{@"ok": @NO, @"error": @"unknown cmd"});
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        gDisplays = [NSMutableDictionary dictionary];

        NSFileHandle *stdinHandle = [NSFileHandle fileHandleWithStandardInput];
        __block NSMutableData *buffer = [NSMutableData data];

        stdinHandle.readabilityHandler = ^(NSFileHandle *fh) {
            NSData *chunk = fh.availableData;
            if (chunk.length == 0) { // stdin closed -> exit, tearing down displays
                dispatch_async(dispatch_get_main_queue(), ^{ exit(0); });
                return;
            }
            [buffer appendData:chunk];
            while (1) {
                NSRange nl = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
                                         options:0
                                           range:NSMakeRange(0, buffer.length)];
                if (nl.location == NSNotFound) break;
                NSData *lineData = [buffer subdataWithRange:NSMakeRange(0, nl.location)];
                [buffer replaceBytesInRange:NSMakeRange(0, nl.location + 1)
                                  withBytes:NULL length:0];
                NSString *line = [[NSString alloc] initWithData:lineData
                                                       encoding:NSUTF8StringEncoding];
                dispatch_async(dispatch_get_main_queue(), ^{ handleLine(line); });
            }
        };

        emit(@{@"ok": @YES, @"ready": @YES});
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
