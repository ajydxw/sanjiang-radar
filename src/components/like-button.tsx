"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Heart } from "lucide-react";
import "./like-button.css";

type LikeButtonProps = {
  title: string;
  count: number | null;
  liked: boolean;
  pending?: boolean;
  disabled?: boolean;
  onToggle: () => void;
};

const PARTICLES = [
  [0, -24, "#fb7185"], [17, -17, "#fbbf24"], [24, 0, "#34d399"], [17, 17, "#38bdf8"],
  [0, 24, "#a78bfa"], [-17, 17, "#f472b6"], [-24, 0, "#fb923c"], [-17, -17, "#2dd4bf"],
] as const;

export default function LikeButton({ title, count, liked, pending = false, disabled = false, onToggle }: LikeButtonProps) {
  const [burst, setBurst] = useState(0);
  const [roll, setRoll] = useState<{ from: number; to: number; id: number } | null>(null);
  const sequence = useRef(0);
  const intent = useRef<{ from: number; id: number; at: number } | null>(null);

  useEffect(() => {
    const next = intent.current;
    if (!next) return;
    if (liked && count === next.from + 1 && performance.now() - next.at < 1000) {
      setRoll({ from: next.from, to: count, id: next.id });
      intent.current = null;
    } else if (count !== next.from || performance.now() - next.at >= 1000) {
      intent.current = null;
    }
  }, [count, liked]);

  function toggle() {
    if (pending || disabled) return;
    const id = ++sequence.current;
    intent.current = !liked && count !== null ? { from: count, id, at: performance.now() } : null;
    setRoll(null);
    setBurst(liked ? 0 : id);
    onToggle();
  }

  const rolling = roll && liked && roll.to === count ? roll : null;
  const label = `${liked ? "取消点赞" : "点赞"}：${title}，${count === null ? "点赞数暂不可用" : `${count} 个赞`}${pending ? "，正在保存" : ""}`;

  return <button type="button" className={`like-button${liked ? " like-liked" : ""}`}
    disabled={disabled || pending} aria-pressed={liked} aria-label={label} aria-busy={pending} onClick={toggle}>
    <span className="like-count" aria-hidden="true">
      {rolling ? <span key={rolling.id} className="like-count-track" onAnimationEnd={() => setRoll(null)}>
        <span className="like-count-value">{rolling.from}</span><span className="like-count-value">{count}</span>
      </span> : <span className="like-count-value">{count ?? "—"}</span>}
    </span>
    <span key={burst} className={`like-heart-wrap${burst && liked ? " like-burst" : ""}`} aria-hidden="true">
      <Heart className="like-heart" size={20} strokeWidth={1.8} />
      {burst > 0 && liked && PARTICLES.map(([x, y, color], index) => <span key={index} className="like-particle"
        style={{ "--like-x": `${x}px`, "--like-y": `${y}px`, "--like-color": color } as CSSProperties} />)}
    </span>
  </button>;
}
