module.exports = {
  outDir: process.env.HERMES_QQ_BUILD_OUT || "out",
  packagerConfig: {
    name: "Hermes QQ Bot",
    executableName: "Hermes QQ Bot",
    appBundleId: "com.eraser.hermesqqbot",
    appCategoryType: "public.app-category.productivity",
    ...(process.env.HERMES_QQ_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.HERMES_QQ_ELECTRON_ZIP_DIR } : {}),
    asar: true,
    osxSign: { identity: "-", identityValidation: false, continueOnError: false },
    ignore: [
      /^\/(?!desktop(?:\/|$)|src(?:\/|$)|public(?:\/|$)|scripts(?:\/|$)|config\.example\.json$|LICENSE$|package\.json$|node_modules(?:\/|$))/, 
      /^\/scripts\/(?!memory-rebuild\.js$|recreate-napcat-stable\.sh$)/,
      /^\/node_modules\/\.cache(?:\/|$)/
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"]
    }
  ]
};
