import { mountStudio } from '../src/studio';
import { demoAdapter } from './bodies';
import { ANIM_CLIPS } from './clips';

// The authored store is passed in LIVE: studio edits mutate it in place, the
// demo bake samples it — exactly how a real game wires its own clips module.
void mountStudio(demoAdapter(ANIM_CLIPS));
