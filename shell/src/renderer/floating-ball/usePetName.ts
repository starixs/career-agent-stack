import { useEffect, useState } from 'react';

import { loadAppConfig } from '@/config/services/appConfigService';
import { listenWithCleanup } from '@/utils/tauriListen';

import { MINO_DEFAULT_PET_PACK } from './defaultPetPack';
import { resolveSelectedPetPack } from './petPackLibrary';

/** 当前选中宠物的名字（用户导入的宠物也算），文案里称呼"它"时用；读不到时回退 Mino。 */
export function usePetName(): string {
    const [name, setName] = useState(MINO_DEFAULT_PET_PACK.displayName);
    useEffect(() => {
        const ac = new AbortController();
        const load = () => {
            void loadAppConfig()
                .then(cfg => resolveSelectedPetPack(cfg.floatingBallPetId))
                .then(pack => { if (!ac.signal.aborted) setName(pack.displayName || MINO_DEFAULT_PET_PACK.displayName); })
                .catch(err => console.warn('[fb-pet] resolve pet name failed:', err));
        };
        load();
        void listenWithCleanup('fb:config-changed', load, ac.signal);
        return () => ac.abort();
    }, []);
    return name;
}
