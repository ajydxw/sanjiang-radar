"use client";

import { useRef, useState, type CSSProperties } from "react";
import { Heart } from "lucide-react";
import "./like-button.css";

type LikeButtonProps = {
  title: string;
  saved: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

const PARTICLES = [
  [0, -24, "#fb7185"], [17, -17, "#fbbf24"], [24, 0, "#34d399"], [17, 17, "#38bdf8"],
  [0, 24, "#a78bfa"], [-17, 17, "#f472b6"], [-24, 0, "#fb923c"], [-17, -17, "#2dd4bf"],
] as const;

export default function LikeButton({ title, saved, disabled = false, onToggle }: LikeButtonProps) {
  const [burst, setBurst] = useState(0);
  const sequence = useRef(0);

  function toggle() {
    if (disabled) return;
    const id = ++sequence.current;
    setBurst(saved ? 0 : id);
    onToggle();
  }

  const label = `${saved ? "取消收藏" : "收藏"}：${title}`;

  return <button type="button" className={`like-button${saved ? " like-liked" : ""}`}
    disabled={disabled} aria-pressed={saved} aria-label={label} onClick={toggle}>
    <span className="favorite-label" aria-hidden="true">{saved ? "已收藏" : "收藏"}</span>
    <span key={burst} className={`like-heart-wrap${burst && saved ? " like-burst" : ""}`} aria-hidden="true">
      <Heart className="like-heart" size={20} strokeWidth={1.8} />
      {burst > 0 && saved && PARTICLES.map(([x, y, color], index) => <span key={index} className="like-particle"
        style={{ "--like-x": `${x}px`, "--like-y": `${y}px`, "--like-color": color } as CSSProperties} />)}
    </span>
  </button>;
}
