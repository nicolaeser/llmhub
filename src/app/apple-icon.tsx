import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#6367ef",
        }}
      >
        <svg width={112} height={112} viewBox="0 0 24 24" fill="#fff">
          <path
            d="M12 5.5v7.25l6.28 3.63M12 12.75l-6.28 3.63"
            fill="none"
            stroke="#fff"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12.75" r="3.25" />
          <circle cx="12" cy="5.5" r="2.25" />
          <circle cx="18.28" cy="16.38" r="2.25" />
          <circle cx="5.72" cy="16.38" r="2.25" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
