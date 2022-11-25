# Unity Shader Extension

This is a Unity Shader Extension that provides some helper function for your Unity3D shader development.

## Ability

### Generate CSharp References

Generate a CSharp reference script so you can access compute shader variables and kernels with it's id you can pass to like setbuffer or dispach method.

You need to call `Setup` method on generated class like:

```c#
public class Example : MonoBehavior
{
    public ComputeShader compute;

    void Start()
    {
        ComputeShaderReferences.MyCompute.Setup(compute);
    }
}
```

### Add variable to property block in shader file

Add variable as property to Unity shader's property block so you don't need to scroll up to top.

`Not yet implemented.`