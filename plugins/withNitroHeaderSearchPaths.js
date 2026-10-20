const { withPodfile } = require('@expo/config-plugins');

const MARKER = '# RealOr NitroModules header search paths';
const HEADER_SEARCH_PATHS = `    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        search_paths = config.build_settings['HEADER_SEARCH_PATHS']
        search_paths = ['$(inherited)'] if search_paths.nil?
        search_paths = [search_paths] unless search_paths.is_a?(Array)
        search_paths |= [
          '"$(PODS_ROOT)/Headers/Public/react-native-nitro-modules"',
          '"$(PODS_ROOT)/../../node_modules/react-native-nitro-modules/cpp"',
        ]
        config.build_settings['HEADER_SEARCH_PATHS'] = search_paths
      end
    end
`;

function addNitroHeaderSearchPaths(podfile) {
  if (podfile.includes(MARKER)) {
    return podfile;
  }

  const postInstallStart = podfile.indexOf('post_install do |installer|');
  if (postInstallStart === -1) {
    throw new Error(
      'Unable to add Nitro header paths: generated Podfile has no installer post_install hook.',
    );
  }

  if (podfile.indexOf('react_native_post_install(', postInstallStart) === -1) {
    throw new Error(
      'Unable to add Nitro header paths: generated Podfile has no react_native_post_install call.',
    );
  }
  const postInstallEndPattern = /^end[ \t]*$/gm;
  postInstallEndPattern.lastIndex = postInstallStart;
  const postInstallEnd = postInstallEndPattern.exec(podfile);
  if (!postInstallEnd) {
    throw new Error(
      'Unable to add Nitro header paths: generated Podfile post_install hook is not closed.',
    );
  }

  return (
    podfile.slice(0, postInstallEnd.index) +
    HEADER_SEARCH_PATHS +
    podfile.slice(postInstallEnd.index)
  );
}

function withNitroHeaderSearchPaths(config) {
  return withPodfile(config, (configWithPodfile) => {
    configWithPodfile.modResults.contents = addNitroHeaderSearchPaths(
      configWithPodfile.modResults.contents,
    );
    return configWithPodfile;
  });
}

module.exports = withNitroHeaderSearchPaths;
module.exports.addNitroHeaderSearchPaths = addNitroHeaderSearchPaths;
