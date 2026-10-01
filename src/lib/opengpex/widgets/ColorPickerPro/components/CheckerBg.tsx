import React from "react";

/** Checkerboard pattern for alpha backgrounds */
export function CheckerBg({ className }: { className?: string }) {
  return (
    <div
      className={`absolute inset-0 ${className || ""}`}
      style={{
        backgroundImage: `
          linear-gradient(45deg, #ccc 25%, transparent 25%),
          linear-gradient(-45deg, #ccc 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #ccc 75%),
          linear-gradient(-45deg, transparent 75%, #ccc 75%)
        `,
        backgroundSize: "8px 8px",
        backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
      }}
    />
  );
}
