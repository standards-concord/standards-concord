// Concord's entry point into the pinned suite-ui copy: the dialog the sign-in card opens in.
// Upstream's own index exports these (and much more) from the same package root, so
// imports stay the same when the published package replaces this copy.
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.js';
