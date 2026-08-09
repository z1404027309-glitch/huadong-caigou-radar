import "./globals.css";

export const metadata = {
  title: "东南三省运营商公告雷达",
  description: "浙江、江西、福建采购公告智能提取与筛选",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
