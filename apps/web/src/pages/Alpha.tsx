import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useDemoOntology, useOntologies } from '../lib/ontologies';
import { Page } from '../components/Shell';
import { Stepper, StepBody } from '../components/Walkthrough';
import { Button, Card } from '../components/ui';
import { STEPS, useWalkthrough } from '../lib/walkthrough';

export function AlphaPage() {
  const w = useWalkthrough();
  const nav = useNavigate();
  const demo = useDemoOntology();
  const { loading } = useOntologies();
  // Wait for the ontology list before leaving, or a quick click lands on the home page instead of the demo.
  const [exploring, setExploring] = useState(false);
  useEffect(() => {
    if (!exploring || loading) return;
    setExploring(false);
    nav(demo ? `/o/${demo.id}` : '/');
  }, [exploring, loading, demo, nav]);
  return (
    <Page>
      <div className="mb-6">
        <div className="mb-1 text-sm font-medium text-muted">Alpha testing · about 5 minutes</div>
        <h1 className="text-2xl font-semibold tracking-tight">Guided walkthrough</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Follow these steps to try Concord as one of the people who would use it. Your progress is saved in this browser, and you can reopen this guide from the
          “Walkthrough” button at the bottom of any page.
        </p>
      </div>
      <Stepper current={w.step} onPick={w.setStep} />
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {w.step + 1}. {STEPS[w.step].title}
        </h2>
        <StepBody step={w.step} />
      </Card>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" icon={ArrowLeft} disabled={w.step === 0} onClick={w.prev}>
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" icon={RotateCcw} onClick={w.reset}>
            Restart
          </Button>
          {w.step >= 2 && (
            <Button
              variant="secondary"
              loading={exploring}
              onClick={() => {
                w.setOpen(true);
                setExploring(true);
              }}
            >
              Keep the guide open while I explore
            </Button>
          )}
          <Button variant="ghost" disabled={w.step === STEPS.length - 1} onClick={w.next}>
            Skip <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>
    </Page>
  );
}
