import sys
out=open(sys.argv[1]).read()
n=int(sys.argv[2]) if len(sys.argv)>2 else 18
for block in out.split('===== ')[1:]:
    title, _, body = block.partition(' =====\n')
    lines=body.rstrip('\n').split('\n')
    print('#####', title)
    print('\n'.join(lines[-n:]))
if 'TIMEOUT' in out: print(out[out.index('TIMEOUT'):][:300])
