"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Density = "comfortable" | "compact";
const DensityContext = createContext<Density | undefined>(undefined);

// Radix roots render no DOM. An inert marker reads their original DOM scope even
// for controlled/default-open overlays without a trigger. Context crosses portals.
function DensityProvider({ children }: { children: ReactNode }) {
  const inherited = useContext(DensityContext);
  const source = useRef<HTMLTemplateElement>(null);
  const [density, setDensity] = useState<Density>();

  useLayoutEffect(() => {
    const marker = source.current;
    if (!marker) return;
    const update = () => {
      const scope = marker.closest('[data-density="comfortable"], [data-density="compact"]');
      setDensity((scope?.getAttribute("data-density") as Density | null) ?? undefined);
    };
    update();
    const observer = new MutationObserver(update);
    // Observe ancestors so adding, changing or removing a nested density updates
    // already-open overlays without observing unrelated document mutations.
    for (let ancestor = marker.parentElement; ancestor; ancestor = ancestor.parentElement)
      observer.observe(ancestor, { attributes: true, attributeFilter: ["data-density"] });
    return () => observer.disconnect();
  }, []);

  return (
    <DensityContext.Provider value={density ?? inherited}>
      <template ref={source} />
      {children}
    </DensityContext.Provider>
  );
}

function useDensity() {
  return useContext(DensityContext);
}

export { DensityProvider, useDensity };
