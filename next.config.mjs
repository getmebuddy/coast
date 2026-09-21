/** @type {import('next').NextConfig} */
const nextConfig = {
  // No image optimization needed; keep the build hermetic.
  images: { unoptimized: true },
};

export default nextConfig;
