import { useLayoutEffect, useRef, useState } from "react";

/** Tracks an element's content box so SVG can be drawn in real pixels (crisp 1px lines). */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(previous => (previous.width === Math.round(width) && previous.height === Math.round(height)
        ? previous : { width: Math.round(width), height: Math.round(height) }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
