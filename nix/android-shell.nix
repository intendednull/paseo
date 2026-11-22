{
  pkgs,
  androidPkgs,
}:
let
  platformVersion = "36";
  buildToolsVersion = "36.0.0";
  ndkVersion = "27.1.12297006";
  cmakeVersion = "3.22.1";

  androidComposition = androidPkgs.androidenv.composeAndroidPackages {
    buildToolsVersions = [
      "35.0.0"
      buildToolsVersion
    ];
    platformVersions = [ platformVersion ];
    includeNDK = true;
    ndkVersions = [ ndkVersion ];
    cmakeVersions = [ cmakeVersion ];
    includeEmulator = false;
    includeSystemImages = false;
  };

  androidSdk = "${androidComposition.androidsdk}/libexec/android-sdk";
in
pkgs.mkShell {
  packages = [
    pkgs.nodejs_22
    pkgs.jdk21
    androidComposition.androidsdk
    pkgs.python3
    pkgs.unzip
    pkgs.zip
    pkgs.openssl
  ];

  JAVA_HOME = "${pkgs.jdk21.home}";
  ANDROID_HOME = androidSdk;
  ANDROID_SDK_ROOT = androidSdk;
  ANDROID_NDK_ROOT = "${androidSdk}/ndk/${ndkVersion}";
  ANDROID_NDK_HOME = "${androidSdk}/ndk/${ndkVersion}";
  PASEO_ANDROID_AAPT2_OVERRIDE = "${androidSdk}/build-tools/${buildToolsVersion}/aapt2";

  shellHook = ''
    export PATH="${androidSdk}/platform-tools:${androidSdk}/build-tools/${buildToolsVersion}:$PATH"
  '';
}
