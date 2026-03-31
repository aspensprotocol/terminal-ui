"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { CanvasBackground } from "./CanvasBackground";

interface LoadingScreenProps {
  isLoading: boolean;
}

export function LoadingScreen({ isLoading }: LoadingScreenProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [isFadingOut, setIsFadingOut] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      // Start fade out animation after a microtask to avoid cascading render
      const fadeTimer = setTimeout(() => setIsFadingOut(true), 0);
      const hideTimer = setTimeout(() => {
        setIsVisible(false);
      }, 400); // Match the animation duration
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(hideTimer);
      };
    }
  }, [isLoading]);

  if (!isVisible) return null;

  return (
    <div
      className={`fixed inset-0 z-[10000] bg-background flex items-center justify-center ${
        isFadingOut ? "loading-exit" : ""
      }`}
      style={{
        imageRendering: "pixelated",
      }}
    >
      {/* Blurred background layer */}
      <div className="absolute inset-0 backdrop-blur-2xl bg-background/90" />

      {/* Animated canvas background */}
      <CanvasBackground dotSize={1.5} spacing={12} animationSpeed={0.0015} dotColor="rgba(150, 150, 150, 0.3)" />

      {/* Logo */}
      <div className="relative z-10">
        {/* Logo with pixelated glow animation */}
        <div className="relative group">
          <div className="absolute inset-0 -m-12 bg-white/10 blur-3xl rounded-full animate-pulse" />
          <div className="absolute inset-0 -m-8 bg-primary/20 blur-2xl rounded-full animate-pulse" />
          <div className="relative dither-strong" style={{ imageRendering: "pixelated" }}>
            <Image
              src="/logo3.png"
              alt="Exchange Logo"
              width={160}
              height={160}
              className="h-[160px] w-[160px] contrast-125 brightness-110"
              style={{ imageRendering: "pixelated" }}
              priority
            />
          </div>
        </div>
      </div>

      {/* Strong dither overlay effect */}
      <div className="dither-strong absolute inset-0 pointer-events-none" />
    </div>
  );
}
