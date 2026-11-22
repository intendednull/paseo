const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_SIGNING_CONFIG_MARKER = "// Paseo env-backed release signing";

const RELEASE_SIGNING_CONFIG_BLOCK = `        ${RELEASE_SIGNING_CONFIG_MARKER}
        release {
            def keystorePath = System.getenv("PASEO_ANDROID_SIGNING_KEYSTORE")
            def passwordFilePath = System.getenv("PASEO_ANDROID_SIGNING_PASSWORD_FILE")
            def aliasName = System.getenv("PASEO_ANDROID_SIGNING_KEY_ALIAS") ?: "paseo-fork"
            if (!keystorePath || !passwordFilePath) {
                throw new GradleException("PASEO_ANDROID_SIGNING_KEYSTORE and PASEO_ANDROID_SIGNING_PASSWORD_FILE must be set for release signing")
            }
            def keystoreFile = file(keystorePath)
            def passwordFile = file(passwordFilePath)
            if (!keystoreFile.exists()) {
                throw new GradleException("Android release keystore not found: " + keystorePath)
            }
            if (!passwordFile.exists()) {
                throw new GradleException("Android release keystore password file not found: " + passwordFilePath)
            }
            def secret = passwordFile.getText("UTF-8").trim()
            storeFile keystoreFile
            storePassword secret
            keyAlias aliasName
            keyPassword secret
        }`;

function configureAndroidReleaseSigning(contents) {
  let updated = contents;

  if (!updated.includes(RELEASE_SIGNING_CONFIG_MARKER)) {
    const signingConfigsPattern = /(signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\n\s*\})/;
    if (!signingConfigsPattern.test(updated)) {
      throw new Error("Could not find signingConfigs.debug block in android/app/build.gradle");
    }
    updated = updated.replace(signingConfigsPattern, `$1\n${RELEASE_SIGNING_CONFIG_BLOCK}`);
  }

  const releaseBlockPattern =
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (releaseBlockPattern.test(updated)) {
    updated = updated.replace(releaseBlockPattern, "$1signingConfig signingConfigs.release");
  } else if (!updated.includes("signingConfig signingConfigs.release")) {
    throw new Error("Could not wire signingConfigs.release into buildTypes.release");
  }

  return updated;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    modConfig.modResults.contents = configureAndroidReleaseSigning(modConfig.modResults.contents);
    return modConfig;
  });
}

withAndroidReleaseSigning.configureAndroidReleaseSigning = configureAndroidReleaseSigning;

module.exports = withAndroidReleaseSigning;
