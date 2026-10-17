#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>

#include <stdio.h>

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        NSVisualEffectView *effect = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(8, 8, 280, 440)];
        effect.material = NSVisualEffectMaterialUnderWindowBackground;
        effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        effect.state = NSVisualEffectStateActive;
        effect.wantsLayer = YES;
        effect.layer.cornerRadius = 17;
        effect.layer.masksToBounds = YES;
        [window.contentView addSubview:effect];
        [window orderFront:nil];
        puts("REA_NATIVE_FIXTURE_READY");
        fflush(stdout);
        [NSApp run];
    }
    return 0;
}
