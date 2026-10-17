#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <string.h>

// Debug-only collector. No UI strings, preferences, or network operations.
__attribute__((visibility("default"))) const char *matrix_capture(void) {
    @autoreleasepool {
        if (![NSThread isMainThread]) return strdup("{\"error\":\"main thread required\"}");
        @try {
        NSString *json =
#include "native_hierarchy.expr"
        ;
        return strdup(json.UTF8String);
        } @catch (NSException *exception) {
            NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"error": exception.name,
                @"reason": exception.reason ?: @"unspecified" } options:0 error:0];
            return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
        }
    }
}
