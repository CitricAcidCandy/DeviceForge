package com.deviceforge.profile;

import android.os.SystemClock;

/** 只读设备单调时钟与开机时钟，供视频帧及Root采样进行有界校时。 */
public final class ClockAnchor {
    private ClockAnchor() { }

    public static void main(String[] args) {
        if (args.length != 0) {
            throw new IllegalArgumentException("时钟助手不接受参数");
        }
        final long before = System.nanoTime();
        final long boot = SystemClock.elapsedRealtimeNanos();
        final long after = System.nanoTime();
        if (before < 0 || boot < 0 || after < before) {
            throw new IllegalStateException("设备时钟无效");
        }
        System.out.println("DFPC1 " + before + " " + boot + " " + after);
    }
}
