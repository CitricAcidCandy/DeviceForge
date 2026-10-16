import { Check } from 'lucide-react';
import { cn } from '../../utils/classnames.ts';
import './styles.css';

export interface StepperStep {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface StepperProps {
  readonly steps: readonly StepperStep[];
  readonly currentStep: number;
  readonly label?: string;
  readonly className?: string;
}

export function Stepper({ steps, currentStep, label = '操作步骤', className }: StepperProps) {
  return (
    <ol className={cn('ui-stepper', className)} aria-label={label}>
      {steps.map((step, index) => {
        const complete = index < currentStep;
        const active = index === currentStep;
        return (
          <li key={step.id} className="ui-stepper-step" data-state={complete ? 'complete' : active ? 'active' : 'pending'} aria-current={active ? 'step' : undefined}>
            <span className="ui-stepper-marker" aria-hidden="true">{complete ? <Check /> : index + 1}</span>
            <span className="ui-stepper-copy">
              <span className="ui-stepper-title">{step.title}</span>
              {step.description && <small>{step.description}</small>}
              <span className="sr-only">{complete ? '已完成' : active ? '进行中' : '待完成'}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
