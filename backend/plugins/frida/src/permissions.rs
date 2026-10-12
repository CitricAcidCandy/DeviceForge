//! 将旧权限分类转成结构化Hook清单，生成器不接收任意JavaScript片段。
use crate::{Error, Result, input::PermissionsInput};
use serde_json::{Value, json};

fn add(items: &mut Vec<Value>, module: &str, class: &str, methods: &str, action: &str) {
    for method in methods.split_whitespace() {
        items.push(json!({"module":module,"class":class,"method":method,"action":action,"messages":action,"args":[]}));
    }
}
pub(crate) fn generate(input: &PermissionsInput) -> Result<String> {
    let mut hooks = Vec::new();
    for (module, class, methods, action) in [
        (
            "permissions",
            "android.support.v4.app.ActivityCompat",
            "requestPermissions",
            "申请权限",
        ),
        (
            "permissions",
            "androidx.core.app.ActivityCompat",
            "requestPermissions",
            "申请权限",
        ),
        (
            "phone",
            "android.telephony.TelephonyManager",
            "getDeviceId getImei getMeid getLine1Number getSimSerialNumber getSubscriberId getSimOperator getNetworkOperator getSimCountryIso getCellLocation getAllCellInfo requestCellInfoUpdate getServiceState",
            "获取电话相关信息",
        ),
        (
            "phone",
            "android.telephony.cdma.CdmaCellLocation",
            "getBaseStationId getNetworkId",
            "获取基站信息",
        ),
        (
            "phone",
            "android.telephony.gsm.GsmCellLocation",
            "getCid getLac",
            "获取基站信息",
        ),
        (
            "phone",
            "android.telephony.SmsManager",
            "sendTextMessageInternal getDefault sendTextMessageWithSelfPermissions sendMultipartTextMessageInternal sendDataMessage sendDataMessageWithSelfPermissions",
            "短信操作",
        ),
        ("system", "android.os.Build", "getSerial", "获取设备序列号"),
        (
            "system",
            "android.app.admin.DevicePolicyManager",
            "getWifiMacAddress",
            "获取设备MAC",
        ),
        (
            "system",
            "android.content.ClipboardManager",
            "getPrimaryClip setPrimaryClip",
            "读写剪贴板",
        ),
        (
            "system",
            "android.telephony.UiccCardInfo",
            "getIccId",
            "获取ICCID",
        ),
        (
            "system",
            "com.android.id.impl.IdProviderImpl",
            "getUDID getOAID getVAID getAAID",
            "获取小米设备标识",
        ),
        (
            "system",
            "com.samsung.android.deviceidservice.IDeviceIdService$Stub$Proxy",
            "getOAID getVAID getAAID",
            "获取三星设备标识",
        ),
        (
            "system",
            "repeackage.com.samsung.android.deviceidservice.IDeviceIdService$Stub$Proxy",
            "getOAID getVAID getAAID",
            "获取三星设备标识",
        ),
        (
            "packages",
            "android.content.pm.PackageManager",
            "getInstalledPackages getInstalledApplications",
            "获取应用列表",
        ),
        (
            "packages",
            "android.app.ApplicationPackageManager",
            "getInstalledPackages getInstalledApplications queryIntentActivities getApplicationInfo getPackageInfoAsUser getInstallerPackageName",
            "获取其他应用信息",
        ),
        (
            "packages",
            "android.app.ActivityManager",
            "getRunningAppProcesses getRunningServiceControlPanel",
            "获取运行应用信息",
        ),
        (
            "location",
            "android.location.LocationManager",
            "requestLocationUpdates getLastKnownLocation getBestProvider getGnssHardwareModelName getGnssYearOfHardware getProvider requestSingleUpdate getCurrentLocation",
            "获取位置信息",
        ),
        (
            "location",
            "android.location.Location",
            "getAccuracy getAltitude getBearing getBearingAccuracyDegrees getElapsedRealtimeNanos getExtras getLatitude getLongitude getProvider getSpeed getSpeedAccuracyMetersPerSecond getTime getVerticalAccuracyMeters",
            "读取位置数据",
        ),
        (
            "location",
            "android.location.Geocoder",
            "getFromLocation getFromLocationName",
            "地理编码",
        ),
        ("camera", "android.hardware.Camera", "open", "调用摄像头"),
        (
            "camera",
            "android.hardware.camera2.CameraManager",
            "openCamera",
            "调用摄像头",
        ),
        (
            "camera",
            "androidx.camera.core.ImageCapture",
            "takePicture",
            "拍照",
        ),
        (
            "network",
            "android.net.wifi.WifiInfo",
            "getMacAddress getSSID getBSSID getIpAddress",
            "获取无线网络信息",
        ),
        (
            "network",
            "android.net.wifi.WifiManager",
            "getConnectionInfo getConfiguredNetworks getScanResults getWifiState",
            "获取无线网络状态",
        ),
        (
            "network",
            "java.net.InetAddress",
            "getHostAddress getAddress getHostName",
            "获取网络地址",
        ),
        (
            "network",
            "java.net.Inet4Address",
            "getHostAddress",
            "获取IPv4地址",
        ),
        (
            "network",
            "java.net.Inet6Address",
            "getHostAddress",
            "获取IPv6地址",
        ),
        (
            "network",
            "java.net.NetworkInterface",
            "getHardwareAddress",
            "获取网络MAC",
        ),
        (
            "network",
            "android.net.NetworkInfo",
            "getType getTypeName getExtraInfo isAvailable isConnected",
            "获取网络连接状态",
        ),
        (
            "network",
            "android.net.ConnectivityManager",
            "getActiveNetworkInfo",
            "获取网络状态",
        ),
        (
            "network",
            "java.net.InetSocketAddress",
            "getHostAddress getAddress getHostName",
            "获取套接字地址",
        ),
        (
            "bluetooth",
            "android.bluetooth.BluetoothDevice",
            "getName getAddress",
            "获取蓝牙设备信息",
        ),
        (
            "bluetooth",
            "android.bluetooth.BluetoothAdapter",
            "getName",
            "获取蓝牙名称",
        ),
        ("files", "java.io.RandomAccessFile", "$init", "文件访问"),
        ("files", "java.io.File", "mkdir mkdirs", "创建目录"),
        (
            "media",
            "android.media.MediaRecorder",
            "start",
            "获取麦克风",
        ),
        (
            "media",
            "android.media.AudioRecord",
            "startRecording",
            "获取麦克风",
        ),
        (
            "sensor",
            "android.hardware.SensorManager",
            "getSensorList",
            "获取传感器信息",
        ),
    ] {
        if input.modules.is_empty() || input.modules.iter().any(|m| m == module) {
            add(&mut hooks, module, class, methods, action);
        }
    }
    if input.modules.is_empty() || input.modules.iter().any(|m| m == "system") {
        for class in [
            "android.provider.Settings$Secure",
            "android.provider.Settings$System",
        ] {
            hooks.push(json!({"module":"system","class":class,"method":"getString","action":"获取系统标识","messages":"获取安卓ID","args":["android_id"]}));
        }
        hooks.push(json!({"module":"system","class":"android.content.ContentResolver","method":"query","action":"获取内容数据","messages":"读取通讯录、日历、浏览器或媒体","args":[],"content_only":true}));
    }
    for hook in &input.hooks {
        hooks.push(json!({"class":hook.class,"method":hook.method,"module":hook.module,"action":hook.action,"messages":hook.messages,"args":hook.args}));
    }
    let configuration = serde_json::to_string(
        &json!({"package":input.package,"show_log":input.show_log,"hooks":hooks}),
    )
    .map_err(|_| Error::Invalid("Hook无法序列化"))?;
    Ok(include_str!("permissions.js").replace("__DEVICEFORGE_CONFIGURATION__", &configuration))
}
