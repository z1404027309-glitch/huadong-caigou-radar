/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  outputFileTracingRoot: process.cwd(),
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  webpack(config) {
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      fs: false,
      path: false,
      crypto: false
    };
    return config;
  }
};

export default nextConfig;
