import { animate, motion, useMotionValue, useMotionValueEvent, useTransform, type MotionValue, type PanInfo } from "motion/react";
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import type { ApiEvent, Via } from "../../../shared/types.ts";
import { EventCard } from "./EventCard.tsx";

export type Decision = "save" | "pass" | "later";

export interface StackHandle {
  /** Throw the top card off screen (for the buttons and arrow keys), then report the decision. */
  fling(decision: Decision): void;
}

interface Props {
  events: ApiEvent[]; // the top three
  onDecide(event: ApiEvent, decision: Decision, via: Via): void;
  onOpen(event: ApiEvent, via: Via): void;
  ref?: Ref<StackHandle>;
}

type Role = "top" | "next" | "after";

const DISTANCE = 100;  // px dragged to count as a swipe
const FLICK = 600;     // px/s: a quick flick counts even if short
const OFFSCREEN: Record<Decision, { x: number; y: number }> = {
  save: { x: 640, y: 40 },
  pass: { x: -640, y: 40 },
  later: { x: 0, y: 960 },
};
const SPRING = { type: "spring", stiffness: 500, damping: 35 } as const;
const ROLES: Role[] = ["top", "next", "after"];

/**
 * Right: save · left: pass · up or tap: details · down: later.
 * Three real cards: the top one, the next event (tilted underneath, with its own data, growing into
 * place as the top one is dragged away), and one more shown as a coloured card at the back.
 * Each card keeps its React identity as it moves up the stack, so nothing re-renders or flashes.
 */
export function CardStack({ events, onDecide, onOpen, ref }: Props) {
  const lift = useMotionValue(0); // 0 at rest → 1 when the top card is far enough away
  const cards = events.slice(0, 3).map((event, i) => ({ event, role: ROLES[i] }));
  return (
    <div className="stack">
      {cards.toReversed().map(({ event, role }) => (
        <StackCard
          key={event.id}
          event={event}
          role={role}
          lift={lift}
          ref={role === "top" ? ref : undefined}
          onDecide={onDecide}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface CardProps {
  event: ApiEvent;
  role: Role;
  lift: MotionValue<number>;
  onDecide: Props["onDecide"];
  onOpen: Props["onOpen"];
  ref?: Ref<StackHandle>;
}

function StackCard({ event, role, lift, onDecide, onOpen, ref }: CardProps) {
  // each card's own drag position: a card that becomes the top one starts centred
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-300, 300], [-16, 16]);
  const nextScale = useTransform(lift, [0, 1], [0.95, 1]);
  const nextY = useTransform(lift, [0, 1], [12, 0]);
  const nextRotate = useTransform(lift, [0, 1], [3, 0]);
  const saveStamp = useTransform(x, [20, DISTANCE], [0, 1]);
  const passStamp = useTransform(x, [-DISTANCE, -20], [1, 0]);
  const moreStamp = useTransform(() => (-y.get() > Math.abs(x.get()) ? Math.min(1, -y.get() / DISTANCE) : 0));
  const laterStamp = useTransform(() => (y.get() > Math.abs(x.get()) ? Math.min(1, y.get() / DISTANCE) : 0));
  const busy = useRef(false);
  const dragged = useRef(false);
  const isTop = role === "top";

  // the top card drives how far the next one has grown into place
  useLayoutEffect(() => {
    if (isTop) lift.set(0);
  }, [isTop, lift]);
  useMotionValueEvent(x, "change", (v) => {
    if (isTop) lift.set(Math.min(1, Math.abs(v) / 120));
  });

  async function fling(decision: Decision, via: Via) {
    if (!isTop || busy.current) return;
    busy.current = true;
    const to = OFFSCREEN[decision];
    await Promise.all([
      animate(x, to.x, { duration: 0.25, ease: "easeIn" }),
      animate(y, to.y, { duration: 0.25, ease: "easeIn" }),
    ]);
    onDecide(event, decision, via);
    // usually this card is gone by the next frame; if it's still on top (the last card in a category
    // sent to "later" comes straight back), bring it back to the middle
    requestAnimationFrame(() => {
      busy.current = false;
      x.set(0);
      y.set(0);
    });
  }

  useImperativeHandle(ref, () => ({ fling: (d: Decision) => void fling(d, "button") }));

  function onDragEnd(_: PointerEvent | MouseEvent | TouchEvent, { offset, velocity }: PanInfo) {
    const horizontal = Math.abs(offset.x) >= Math.abs(offset.y);
    if (horizontal && (offset.x > DISTANCE || velocity.x > FLICK)) return void fling("save", "swipe");
    if (horizontal && (offset.x < -DISTANCE || velocity.x < -FLICK)) return void fling("pass", "swipe");
    if (!horizontal && (offset.y > DISTANCE || velocity.y > FLICK)) return void fling("later", "swipe");
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
    if (!horizontal && (offset.y < -DISTANCE || velocity.y < -FLICK)) onOpen(event, "swipe");
  }

  if (!isTop) {
    const style = role === "next"
      ? { x: 0, y: nextY, scale: nextScale, rotate: nextRotate, zIndex: 2 }
      : { x: 0, y: 22, scale: 0.92, rotate: -4, zIndex: 1 };
    return (
      <motion.div className={`card ${role}`} style={style} aria-hidden="true">
        <EventCard event={event} />
      </motion.div>
    );
  }
  return (
    <motion.div
      className="card top"
      style={{ x, y, rotate, scale: 1, zIndex: 3 }}
      drag
      onPointerDown={() => (dragged.current = false)}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={onDragEnd}
      onTap={() => {
        if (!dragged.current && !busy.current) onOpen(event, "tap");
      }}
      whileDrag={{ cursor: "grabbing" }}
    >
      <EventCard event={event} />
      <motion.span className="stamp save" style={{ opacity: saveStamp }} aria-hidden="true">SAVE</motion.span>
      <motion.span className="stamp pass" style={{ opacity: passStamp }} aria-hidden="true">PASS</motion.span>
      <motion.span className="stamp more" style={{ opacity: moreStamp }} aria-hidden="true">DETAILS</motion.span>
      <motion.span className="stamp later" style={{ opacity: laterStamp }} aria-hidden="true">LATER</motion.span>
    </motion.div>
  );
}
