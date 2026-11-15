// Font Awesome icons (atsu.moe's icon family: regular style where the free set has it, else solid).
// Rendered as plain inline SVG so they work inside the content script's shadow DOM with no extra CSS.
import type { IconDefinition } from '@fortawesome/fontawesome-common-types';
import { faBell } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowsRotate,
  faArrowUpRightFromSquare,
  faBookOpen,
  faBox,
  faChevronDown,
  faCircleCheck,
  faCircleXmark,
  faCloudArrowDown,
  faDownload,
  faGlobe,
  faLink,
  faLinkSlash,
  faMagnifyingGlass,
  faMinus,
  faPlus,
  faRotateLeft,
  faTableColumns,
  faTrash,
  faUpload,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

export const ICONS = {
  bell: faBell,
  book: faBookOpen,
  refresh: faArrowsRotate,
  external: faArrowUpRightFromSquare,
  box: faBox,
  chevronDown: faChevronDown,
  check: faCircleCheck,
  xcircle: faCircleXmark,
  download: faDownload,
  cloudDown: faCloudArrowDown,
  globe: faGlobe,
  link: faLink,
  unlink: faLinkSlash,
  search: faMagnifyingGlass,
  minus: faMinus,
  plus: faPlus,
  undo: faRotateLeft,
  panel: faTableColumns,
  trash: faTrash,
  upload: faUpload,
  x: faXmark,
} satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICONS;
