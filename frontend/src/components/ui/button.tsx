import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-element text-[12px] leading-[1.5] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-content-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-page disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-fill-button text-background-page hover:bg-content-secondary',
        destructive: 'bg-red-600 text-content-primary hover:bg-red-700',
        outline: 'border border-border-subtle bg-transparent text-content-primary hover:bg-overlay-subtle',
        ghost: 'text-content-primary hover:bg-overlay-subtle',
        link: 'text-content-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-[38px] px-[14px] py-[10px]',
        sm: 'h-[28px] px-3 py-1',
        lg: 'h-11 px-6 py-3',
        icon: 'h-7 w-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
