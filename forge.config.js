/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    name: 'Navio',
    executableName: 'navio-browser',
    asar: true,
    icon: './src/assets/icon',
    extraResource: ['./public']
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'navio_browser'
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32', 'darwin']
    }
  ],
  plugins: []
};
